// Judges. A judge registers once (judgeAccounts) and gets a permanent judge code.
// The admin enters that code to INVITE the judge to an event -> a pending invitation
// (judgeInvitations) -> the judge sees it on their dashboard and accepts or declines.
// Only "accept" adds them to the event (a "judges" document = their seat in that event).
//
// Duplicates are stopped by unique indexes (see setup-db.js):
//   judgeInvitations { eventId, accountId } where status = 'pending' -> one open invite per judge per event
//   judges           { eventId, accountId }                          -> a judge is in an event at most once

const express = require('express');
const config = require('../config');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess, requireJudge, findJudgeSeat } = require('../middleware/auth');
const { httpError, parseId, isNonEmptyString } = require('../middleware/validate');
const { recomputeLeaderboard } = require('../services/leaderboard');
const sse = require('../services/sse');

const router = express.Router();

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// GET /api/events/:eventId/judges  -> judges in the event, with their code and how many teams they scored
router.get('/events/:eventId/judges', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);
  const judges = await getDb()
    .collection('judges')
    .aggregate([
      { $match: { eventId } },
      { $sort: { name: 1 } },
      { $lookup: { from: 'judgeAccounts', localField: 'accountId', foreignField: '_id', as: 'account' } },
      // Count this judge's scores without copying the score documents.
      {
        $lookup: {
          from: 'scores',
          let: { id: '$_id' },
          pipeline: [{ $match: { $expr: { $eq: ['$judgeId', '$$id'] } } }, { $count: 'n' }],
          as: 'scored',
        },
      },
      {
        $project: {
          name: 1,
          joinedAt: 1,
          code: { $first: '$account.code' },
          scoredCount: { $ifNull: [{ $first: '$scored.n' }, 0] },
        },
      },
    ])
    .toArray();
  res.json(judges);
});

// POST /api/events/:eventId/judges  { code }  -> invites the judge with this judge code
router.post('/events/:eventId/judges', requireAdmin, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);
  const event = await db.collection('events').findOne({ _id: eventId }, { projection: { name: 1, status: 1 } });
  if (!event) throw httpError(404, 'Event not found');
  if (event.status === 'closed') throw httpError(409, 'This event has ended, so no more judges can be invited');

  const { code } = req.body || {};
  if (!isNonEmptyString(code, 50)) throw httpError(400, 'judge code is required');
  const account = await db.collection('judgeAccounts').findOne({ code: code.trim().toUpperCase() }, { projection: { name: 1, code: 1 } });
  if (!account) throw httpError(404, 'No judge has this code');

  const already = await db.collection('judges').findOne({ eventId, accountId: account._id }, { projection: { _id: 1 } });
  if (already) throw httpError(409, `${account.name} is already a judge in this event`);

  const invitation = {
    eventId,
    accountId: account._id,
    invitedBy: req.adminUsername || config.adminUsername,
    status: 'pending',
    createdAt: new Date(),
  };
  try {
    const { insertedId } = await db.collection('judgeInvitations').insertOne(invitation);
    res.status(201).json({ _id: insertedId, name: account.name, code: account.code, createdAt: invitation.createdAt });
  } catch (err) {
    // unique_pending_invite: this judge already has an invitation waiting for this event.
    if (err.code === 11000) throw httpError(409, `${account.name} is already invited - waiting for them to accept`);
    throw err;
  }
});

// GET /api/events/:eventId/judge-invitations  -> invitations still waiting for an answer
router.get('/events/:eventId/judge-invitations', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);
  const invitations = await getDb()
    .collection('judgeInvitations')
    .aggregate([
      { $match: { eventId, status: 'pending' } },
      { $lookup: { from: 'judgeAccounts', localField: 'accountId', foreignField: '_id', as: 'account' } },
      { $unwind: '$account' },
      { $project: { createdAt: 1, name: '$account.name', code: '$account.code' } },
      { $sort: { createdAt: -1 } },
    ])
    .toArray();
  res.json(invitations);
});

// DELETE /api/judge-invitations/:id  -> the admin withdraws a pending invitation
router.delete('/judge-invitations/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id, 'invitation id');
  const invitation = await db.collection('judgeInvitations').findOne({ _id: id });
  if (!invitation) throw httpError(404, 'Invitation not found');
  await assertEventAccess(req, invitation.eventId);
  if (invitation.status !== 'pending') throw httpError(409, 'The judge has already answered this invitation');
  await db.collection('judgeInvitations').deleteOne({ _id: id, status: 'pending' });
  res.json({ message: 'Invitation withdrawn' });
});

// DELETE /api/judges/:id  -> removes the judge from the event, with their scores.
// The judge ACCOUNT stays (it may be in other events).
router.delete('/judges/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const judgeId = parseId(req.params.id, 'judge id');
  const judge = await db.collection('judges').findOne({ _id: judgeId });
  if (!judge) throw httpError(404, 'Judge not found');
  await assertEventAccess(req, judge.eventId);

  await db.collection('judges').deleteOne({ _id: judgeId });
  await db.collection('scores').deleteMany({ judgeId });
  // The Change Stream only re-ranks LIVE events after a delete, so refresh this
  // event directly too (it might be draft or closed).
  await recomputeLeaderboard(judge.eventId);
  res.json({ message: 'Judge removed from the event, with their scores' });
});

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

// GET /api/judge/me  -> the judge's account, the events they judge and pending invitations
router.get('/judge/me', requireJudge, async (req, res) => {
  const db = getDb();
  const account = req.judgeAccount;

  // One row per event this judge is in, with how many teams it has and how many they scored.
  const events = await db
    .collection('judges')
    .aggregate([
      { $match: { accountId: account._id } },
      { $lookup: { from: 'events', localField: 'eventId', foreignField: '_id', as: 'event' } },
      { $unwind: '$event' },
      {
        $lookup: {
          from: 'teams',
          let: { id: '$eventId' },
          pipeline: [{ $match: { $expr: { $eq: ['$eventId', '$$id'] } } }, { $count: 'n' }],
          as: 'teams',
        },
      },
      {
        $lookup: {
          from: 'scores',
          let: { id: '$_id' },
          pipeline: [{ $match: { $expr: { $eq: ['$judgeId', '$$id'] } } }, { $count: 'n' }],
          as: 'scored',
        },
      },
      {
        $project: {
          _id: 0,
          eventId: 1,
          joinedAt: 1,
          name: '$event.name',
          status: '$event.status',
          teamCount: { $ifNull: [{ $first: '$teams.n' }, 0] },
          scoredCount: { $ifNull: [{ $first: '$scored.n' }, 0] },
        },
      },
      { $sort: { joinedAt: -1 } },
    ])
    .toArray();

  const invitations = await db
    .collection('judgeInvitations')
    .aggregate([
      { $match: { accountId: account._id, status: 'pending' } },
      { $lookup: { from: 'events', localField: 'eventId', foreignField: '_id', as: 'event' } },
      { $unwind: '$event' },
      { $project: { eventId: 1, invitedBy: 1, createdAt: 1, eventName: '$event.name', eventStatus: '$event.status' } },
      { $sort: { createdAt: -1 } },
    ])
    .toArray();

  res.json({ judge: { _id: account._id, name: account.name, code: account.code }, events, invitations });
});

// POST /api/judge/invitations/:id  { accept: true | false }  -> the judge answers
router.post('/judge/invitations/:id', requireJudge, async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id, 'invitation id');
  const { accept } = req.body || {};
  if (typeof accept !== 'boolean') throw httpError(400, 'accept must be true or false');

  const account = req.judgeAccount;
  const invitation = await db.collection('judgeInvitations').findOne({ _id: id, accountId: account._id });
  if (!invitation) throw httpError(404, 'Invitation not found');
  if (invitation.status !== 'pending') throw httpError(409, `You already ${invitation.status} this invitation`);

  const event = await db.collection('events').findOne({ _id: invitation.eventId }, { projection: { name: 1, status: 1 } });
  if (!event) throw httpError(404, 'This event no longer exists');

  if (accept) {
    if (event.status === 'closed') throw httpError(409, 'This event has already ended');
    try {
      // The judge's seat in the event. Scores point at this document's _id.
      await db.collection('judges').insertOne({ eventId: event._id, accountId: account._id, name: account.name, joinedAt: new Date() });
    } catch (err) {
      // unique_event_account: already in the event (e.g. accepted twice at once) - that's fine.
      if (err.code !== 11000) throw err;
    }
  }

  await db
    .collection('judgeInvitations')
    .updateOne({ _id: id, status: 'pending' }, { $set: { status: accept ? 'accepted' : 'declined', respondedAt: new Date() } });
  // The admin's open event page updates its judge list straight away.
  sse.broadcast(event._id.toString(), 'roster', { kind: 'judge' });
  res.json({ message: accept ? `You are now a judge in ${event.name}` : `You declined ${event.name}`, event: { _id: event._id, name: event.name } });
});

// GET /api/judge/events/:eventId  -> what the scoring page needs: event + rubric, teams, my scores
router.get('/judge/events/:eventId', requireJudge, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.eventId, 'event id');
  const seat = await findJudgeSeat(req, eventId);

  const event = await db.collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');

  // Each team with its submission (repo link + slides info). The account id and
  // file id are left out of what the judge's browser receives.
  const teams = await db
    .collection('teams')
    .aggregate([
      { $match: { eventId } },
      { $sort: { name: 1 } },
      { $project: { codeHash: 0, accountId: 0 } },
      { $lookup: { from: 'submissions', localField: '_id', foreignField: 'teamId', as: 'submission' } },
      {
        $set: {
          githubUrl: { $first: '$submission.githubUrl' },
          slides: { $first: '$submission.slides' },
        },
      },
      { $project: { submission: 0, 'slides.fileId': 0, 'slides.contentType': 0 } },
    ])
    .toArray();
  const myScores = await db.collection('scores').find({ eventId, judgeId: seat._id }).toArray();

  res.json({
    judge: { _id: seat._id, name: seat.name },
    event: { _id: event._id, name: event.name, status: event.status, rubric: event.rubric },
    teams,
    myScores,
  });
});

module.exports = router;
