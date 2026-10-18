// Teams. Admin creates and manages them; a logged-in team can view its own results.
// Each team REFERENCES its event by eventId.

const express = require('express');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess, requireTeam, sha256, generateCode } = require('../middleware/auth');
const { httpError, parseId, isNonEmptyString, cleanMembers } = require('../middleware/validate');

const router = express.Router();

// The code hash is secret, so never send it to any browser.
const HIDE_CODE = { projection: { codeHash: 0 } };

// Loads a team by id and checks this admin may manage its event.
async function findTeamForAdmin(req, teamId) {
  const team = await getDb().collection('teams').findOne({ _id: teamId }, HIDE_CODE);
  if (!team) throw httpError(404, 'Team not found');
  assertEventAccess(req, team.eventId);
  return team;
}

// GET /api/events/:eventId/teams
router.get('/events/:eventId/teams', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  assertEventAccess(req, eventId);
  // Uses the { eventId: 1 } index on teams.
  const teams = await getDb().collection('teams').find({ eventId }, HIDE_CODE).sort({ name: 1 }).toArray();
  res.json(teams);
});

// POST /api/events/:eventId/teams  { name, members: [String] }
router.post('/events/:eventId/teams', requireAdmin, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.eventId, 'event id');
  assertEventAccess(req, eventId);
  const { name, members } = req.body || {};

  if (!isNonEmptyString(name, 100)) throw httpError(400, 'name is required (max 100 characters)');
  const cleanedMembers = cleanMembers(members);
  if (cleanedMembers === null) throw httpError(400, 'members must be a list of up to 20 names');

  const event = await db.collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');

  // Like judges, each team gets an access code. Only its hash is stored.
  const code = generateCode();
  const team = { eventId, name: name.trim(), members: cleanedMembers, codeHash: sha256(code) };
  const result = await db.collection('teams').insertOne(team);
  res.status(201).json({
    _id: result.insertedId,
    eventId,
    name: team.name,
    members: team.members,
    code,
    message: 'Save this code now - it will not be shown again',
  });
});

// POST /api/teams/:id/reset-code  -> new code (the old one stops working), shown ONCE
router.post('/teams/:id/reset-code', requireAdmin, async (req, res) => {
  const teamId = parseId(req.params.id, 'team id');
  await findTeamForAdmin(req, teamId);
  const code = generateCode();
  const team = await getDb()
    .collection('teams')
    .findOneAndUpdate({ _id: teamId }, { $set: { codeHash: sha256(code) } }, { returnDocument: 'after', ...HIDE_CODE });
  if (!team) throw httpError(404, 'Team not found');
  res.json({ _id: team._id, name: team.name, code, message: 'Save this code now - it will not be shown again' });
});

// PATCH /api/teams/:id  { name?, members? }
router.patch('/teams/:id', requireAdmin, async (req, res) => {
  const teamId = parseId(req.params.id, 'team id');
  await findTeamForAdmin(req, teamId);
  const { name, members } = req.body || {};
  const changes = {};

  if (name !== undefined) {
    if (!isNonEmptyString(name, 100)) throw httpError(400, 'name must be 1-100 characters');
    changes.name = name.trim();
  }
  if (members !== undefined) {
    const cleanedMembers = cleanMembers(members);
    if (cleanedMembers === null) throw httpError(400, 'members must be a list of up to 20 names');
    changes.members = cleanedMembers;
  }
  if (Object.keys(changes).length === 0) throw httpError(400, 'Send name and/or members to update');

  const db = getDb();
  const updated = await db
    .collection('teams')
    .findOneAndUpdate({ _id: teamId }, { $set: changes }, { returnDocument: 'after', ...HIDE_CODE });
  if (!updated) throw httpError(404, 'Team not found');

  // The leaderboard keeps a copy of the team name, so update that copy too.
  if (changes.name) {
    await db.collection('leaderboard').updateMany({ teamId }, { $set: { teamName: changes.name } });
  }
  res.json(updated);
});

// DELETE /api/teams/:id  -> also removes the team's scores, leaderboard row and feedback.
router.delete('/teams/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const teamId = parseId(req.params.id, 'team id');
  await findTeamForAdmin(req, teamId);

  const result = await db.collection('teams').deleteOne({ _id: teamId });
  if (result.deletedCount === 0) throw httpError(404, 'Team not found');

  // Deleting scores fires the Change Stream, which re-ranks the remaining teams.
  await db.collection('scores').deleteMany({ teamId });
  await db.collection('leaderboard').deleteMany({ teamId });
  await db.collection('feedback').deleteMany({ teamId });
  res.json({ message: 'Team deleted' });
});

// GET /api/team/me  -> everything the team page needs
router.get('/team/me', requireTeam, async (req, res) => {
  const db = getDb();
  const team = req.team;

  const event = await db
    .collection('events')
    .findOne({ _id: team.eventId }, { projection: { name: 1, status: 1, rubric: 1, demo: 1 } });
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

  // AI feedback is only revealed once the event is closed.
  const feedback =
    event.status === 'closed'
      ? await db.collection('feedback').findOne({ eventId: event._id, teamId: team._id }, { projection: { _id: 0 } })
      : null;

  res.json({
    team: { _id: team._id, name: team.name, members: team.members },
    event,
    standing: standing
      ? { rank: standing.rank, avgScore: standing.avgScore, judgesCount: standing.judgesCount }
      : null,
    totalTeams,
    breakdown: event.rubric.map((item) => {
      const found = breakdown.find((b) => b._id === item.key);
      return { key: item.key, label: item.label, max: item.max, weight: item.weight, avg: found ? Math.round(found.avg * 100) / 100 : null };
    }),
    feedback,
  });
});

module.exports = router;
