// Invitations: how a team joins an event.
// The admin enters a team's code -> a PENDING invitation is saved -> the team sees a
// pop-up on its dashboard and accepts or declines. Only "accept" adds the team.
//
// Duplicates are stopped by unique indexes (see setup-db.js):
//   invitations { eventId, accountId } where status = 'pending'  -> one open invite per team per event
//   teams       { eventId, accountId }                           -> a team is in an event at most once

const express = require('express');
const config = require('../config');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess, requireTeam } = require('../middleware/auth');
const { httpError, parseId, isNonEmptyString } = require('../middleware/validate');

const router = express.Router();

const MAX_INVITES = 500;

// The admin's name as the team will see it.
function adminName(req) {
  if (req.demoEventId) return 'Demo admin';
  return req.adminUsername || config.adminUsername;
}

// Invites ONE team code to an event. Returns { ok: true, team } or { ok: false, reason }.
async function inviteCode(db, req, event, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, code, reason: 'missing team code' };

  const account = await db.collection('teamAccounts').findOne({ code }, { projection: { name: 1, code: 1, members: 1 } });
  if (!account) return { ok: false, code, reason: 'no team has this code' };

  const already = await db.collection('teams').findOne({ eventId: event._id, accountId: account._id }, { projection: { _id: 1 } });
  if (already) return { ok: false, code, name: account.name, reason: 'already in this event' };

  try {
    const invitation = {
      eventId: event._id,
      accountId: account._id,
      invitedBy: adminName(req),
      status: 'pending',
      createdAt: new Date(),
    };
    const { insertedId } = await db.collection('invitations').insertOne(invitation);
    return { ok: true, invitation: { _id: insertedId, code, name: account.name, members: account.members, createdAt: invitation.createdAt } };
  } catch (err) {
    // unique_pending_invite: this team already has an invitation waiting for this event.
    if (err.code === 11000) return { ok: false, code, name: account.name, reason: 'already invited - waiting for the team to accept' };
    throw err;
  }
}

// POST /api/events/:eventId/invitations  { code } or { codes: [...] } (Excel import)
router.post('/events/:eventId/invitations', requireAdmin, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);
  const event = await db.collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');
  if (event.status === 'closed') throw httpError(409, 'This event has ended, so no more teams can be invited');

  const { code, codes } = req.body || {};
  // One code: answer with a clear error the admin sees straight away.
  if (codes === undefined) {
    if (!isNonEmptyString(code, 50)) throw httpError(400, 'team code is required');
    const result = await inviteCode(db, req, event, code);
    if (!result.ok) throw httpError(result.reason === 'no team has this code' ? 404 : 409, `${result.name ? `${result.name}: ` : ''}${result.reason}`);
    return res.status(201).json(result.invitation);
  }

  // Many codes (Excel import): invite every valid one, report the rest.
  if (!Array.isArray(codes) || codes.length === 0) throw httpError(400, 'codes must be a non-empty list');
  if (codes.length > MAX_INVITES) throw httpError(400, `You can invite at most ${MAX_INVITES} teams at once`);
  const invited = [];
  const skipped = [];
  const seen = new Set();
  for (const [i, raw] of codes.entries()) {
    const key = String(raw || '').trim().toUpperCase();
    if (seen.has(key)) {
      skipped.push({ row: i + 1, code: key, reason: 'listed twice in the sheet' });
      continue;
    }
    seen.add(key);
    const result = await inviteCode(db, req, event, raw);
    if (result.ok) invited.push(result.invitation);
    else skipped.push({ row: i + 1, code: result.code, name: result.name, reason: result.reason });
  }
  res.status(201).json({ invited, skipped });
});

// GET /api/events/:eventId/invitations  -> invitations still waiting for an answer
router.get('/events/:eventId/invitations', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);
  const invitations = await getDb()
    .collection('invitations')
    .aggregate([
      { $match: { eventId, status: 'pending' } },
      { $lookup: { from: 'teamAccounts', localField: 'accountId', foreignField: '_id', as: 'account' } },
      { $unwind: '$account' },
      { $project: { createdAt: 1, invitedBy: 1, name: '$account.name', code: '$account.code', members: '$account.members' } },
      { $sort: { createdAt: -1 } },
    ])
    .toArray();
  res.json(invitations);
});

// DELETE /api/invitations/:id  -> the admin withdraws a pending invitation
router.delete('/invitations/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id, 'invitation id');
  const invitation = await db.collection('invitations').findOne({ _id: id });
  if (!invitation) throw httpError(404, 'Invitation not found');
  await assertEventAccess(req, invitation.eventId);
  if (invitation.status !== 'pending') throw httpError(409, 'The team has already answered this invitation');
  await db.collection('invitations').deleteOne({ _id: id, status: 'pending' });
  res.json({ message: 'Invitation withdrawn' });
});

// POST /api/team/invitations/:id  { accept: true | false }  -> the team answers
router.post('/team/invitations/:id', requireTeam, async (req, res) => {
  const db = getDb();
  const id = parseId(req.params.id, 'invitation id');
  const { accept } = req.body || {};
  if (typeof accept !== 'boolean') throw httpError(400, 'accept must be true or false');

  const account = req.teamAccount;
  const invitation = await db.collection('invitations').findOne({ _id: id, accountId: account._id });
  if (!invitation) throw httpError(404, 'Invitation not found');
  if (invitation.status !== 'pending') throw httpError(409, `You already ${invitation.status} this invitation`);

  const event = await db.collection('events').findOne({ _id: invitation.eventId }, { projection: { name: 1, status: 1 } });
  if (!event) throw httpError(404, 'This event no longer exists');

  if (accept) {
    if (event.status === 'closed') throw httpError(409, 'This event has already ended');
    try {
      // The team's place in the event. Name and members are copied from the account.
      await db.collection('teams').insertOne({
        eventId: event._id,
        accountId: account._id,
        name: account.name,
        members: account.members,
        joinedAt: new Date(),
      });
    } catch (err) {
      // unique_event_account: already in the event (e.g. accepted twice at once) - that's fine.
      if (err.code !== 11000) throw err;
    }
  }

  await db
    .collection('invitations')
    .updateOne({ _id: id, status: 'pending' }, { $set: { status: accept ? 'accepted' : 'declined', respondedAt: new Date() } });
  res.json({ message: accept ? `You joined ${event.name}` : `You declined ${event.name}`, event: { _id: event._id, name: event.name } });
});

module.exports = router;
