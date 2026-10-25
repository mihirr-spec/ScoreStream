// Teams. A team REGISTERS its own account (see routes/auth.js) and joins an event only
// by accepting an admin's invitation (see routes/invitations.js). A document in the
// "teams" collection is one team's place in one event: scores, the leaderboard and
// feedback all point at it.

const express = require('express');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess, requireTeam } = require('../middleware/auth');
const { httpError, parseId } = require('../middleware/validate');
const { publicSubmission, deleteSubmissions } = require('./submissions');

const router = express.Router();

// The old-style code hash is secret, so never send it to any browser.
const HIDE_CODE = { projection: { codeHash: 0 } };

// GET /api/events/:eventId/teams  -> the teams in an event, each with its team code
router.get('/events/:eventId/teams', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);
  // Uses the { eventId: 1 } index on teams; $lookup adds the team code from teamAccounts.
  const teams = await getDb()
    .collection('teams')
    .aggregate([
      { $match: { eventId } },
      { $sort: { name: 1 } },
      { $lookup: { from: 'teamAccounts', localField: 'accountId', foreignField: '_id', as: 'account' } },
      { $set: { code: { $first: '$account.code' } } },
      { $project: { account: 0, codeHash: 0 } },
      // The team's submission (repo link + slides info), if it has one.
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
  res.json(teams);
});

// DELETE /api/teams/:id  -> removes the team from its event, with its scores,
// leaderboard row and feedback. The team ACCOUNT stays (it may be in other events).
router.delete('/teams/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const teamId = parseId(req.params.id, 'team id');
  const team = await db.collection('teams').findOne({ _id: teamId }, HIDE_CODE);
  if (!team) throw httpError(404, 'Team not found');
  await assertEventAccess(req, team.eventId);

  await db.collection('teams').deleteOne({ _id: teamId });
  // Deleting scores fires the Change Stream, which re-ranks the remaining teams.
  await db.collection('scores').deleteMany({ teamId });
  await db.collection('leaderboard').deleteMany({ teamId });
  await db.collection('feedback').deleteMany({ teamId });
  await deleteSubmissions({ teamId });
  res.json({ message: 'Team removed from the event' });
});

// GET /api/team/me  -> the team account, the events it is in, and pending invitations
router.get('/team/me', requireTeam, async (req, res) => {
  const db = getDb();
  const account = req.teamAccount;

  // One row per event this team takes part in, with its rank there (if scored).
  const events = await db
    .collection('teams')
    .aggregate([
      { $match: { accountId: account._id } },
      { $lookup: { from: 'events', localField: 'eventId', foreignField: '_id', as: 'event' } },
      { $unwind: '$event' },
      {
        $lookup: {
          from: 'leaderboard',
          let: { eventId: '$eventId', teamId: '$_id' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$eventId', '$$eventId'] }, { $eq: ['$teamId', '$$teamId'] }] } } }],
          as: 'standing',
        },
      },
      {
        $project: {
          _id: 0,
          eventId: 1,
          teamId: '$_id',
          name: '$event.name',
          status: '$event.status',
          createdAt: '$event.createdAt',
          rank: { $first: '$standing.rank' },
          avgScore: { $first: '$standing.avgScore' },
        },
      },
      { $sort: { createdAt: -1 } },
    ])
    .toArray();

  // Invitations still waiting for an answer, with the event's name.
  const invitations = await db
    .collection('invitations')
    .aggregate([
      { $match: { accountId: account._id, status: 'pending' } },
      { $lookup: { from: 'events', localField: 'eventId', foreignField: '_id', as: 'event' } },
      { $unwind: '$event' },
      { $project: { eventId: 1, invitedBy: 1, createdAt: 1, eventName: '$event.name', eventStatus: '$event.status' } },
      { $sort: { createdAt: 1 } },
    ])
    .toArray();

  res.json({
    team: { _id: account._id, name: account.name, members: account.members, code: account.code },
    events,
    invitations,
  });
});

// GET /api/team/events/:eventId  -> this team's results in one of its events
router.get('/team/events/:eventId', requireTeam, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.eventId, 'event id');
  const team = await db.collection('teams').findOne({ eventId, accountId: req.teamAccount._id }, HIDE_CODE);
  if (!team) throw httpError(404, 'Your team is not in this event');

  const event = await db
    .collection('events')
    .findOne({ _id: eventId }, { projection: { name: 1, status: 1, rubric: 1 } });
  if (!event) throw httpError(404, 'Event not found');

  // This team's row on the leaderboard (written by the aggregation's $merge).
  const standing = await db.collection('leaderboard').findOne({ eventId: event._id, teamId: team._id });
  const totalTeams = await db.collection('teams').countDocuments({ eventId: event._id });

  // Average mark per rubric criterion, across all judges.
  // criteria is an object like { design: 7, idea: 8 }, so $objectToArray turns it into
  // [{ k: 'design', v: 7 }, { k: 'idea', v: 8 }], $unwind gives one document per pair,
  // and $group averages the marks of each key.
  const breakdown = await db
    .collection('scores')
    .aggregate([
      { $match: { eventId: event._id, teamId: team._id } },
      { $project: { pairs: { $objectToArray: '$criteria' } } },
      { $unwind: '$pairs' },
      { $group: { _id: '$pairs.k', avg: { $avg: '$pairs.v' } } },
    ])
    .toArray();

  // Every judge's own score for this team, newest first, with the judge's name
  // joined in from the judges collection ($lookup = MongoDB's "join").
  const judgeScores = await db
    .collection('scores')
    .aggregate([
      { $match: { eventId: event._id, teamId: team._id } },
      { $lookup: { from: 'judges', localField: 'judgeId', foreignField: '_id', as: 'judge' } },
      { $project: { _id: 0, judgeName: { $ifNull: [{ $first: '$judge.name' }, 'Judge'] }, criteria: 1, total: 1, comment: 1, submittedAt: 1 } },
      { $sort: { submittedAt: -1 } },
    ])
    .toArray();

  // AI feedback is only revealed once the event is closed.
  const feedback =
    event.status === 'closed'
      ? await db.collection('feedback').findOne({ eventId: event._id, teamId: team._id }, { projection: { _id: 0 } })
      : null;

  res.json({
    team: { _id: team._id, name: team.name, members: team.members },
    event: { _id: event._id, name: event.name, status: event.status, rubric: event.rubric },
    standing: standing
      ? { rank: standing.rank, avgScore: standing.avgScore, judgesCount: standing.judgesCount }
      : null,
    totalTeams,
    breakdown: event.rubric.map((item) => {
      const found = breakdown.find((b) => b._id === item.key);
      return { key: item.key, label: item.label, max: item.max, weight: item.weight, avg: found ? Math.round(found.avg * 100) / 100 : null };
    }),
    judgeScores,
    feedback,
    submission: publicSubmission(await db.collection('submissions').findOne({ teamId: team._id })),
  });
});

module.exports = router;
