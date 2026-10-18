// Teams (admin only). Each team REFERENCES its event by eventId.

const express = require('express');
const { getDb } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { httpError, parseId, isNonEmptyString, cleanMembers } = require('../middleware/validate');

const router = express.Router();

// GET /api/events/:eventId/teams
router.get('/events/:eventId/teams', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  // Uses the { eventId: 1 } index on teams.
  const teams = await getDb().collection('teams').find({ eventId }).sort({ name: 1 }).toArray();
  res.json(teams);
});

// POST /api/events/:eventId/teams  { name, members: [String] }
router.post('/events/:eventId/teams', requireAdmin, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.eventId, 'event id');
  const { name, members } = req.body || {};

  if (!isNonEmptyString(name, 100)) throw httpError(400, 'name is required (max 100 characters)');
  const cleanedMembers = cleanMembers(members);
  if (cleanedMembers === null) throw httpError(400, 'members must be a list of up to 20 names');

  const event = await db.collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');

  const team = { eventId, name: name.trim(), members: cleanedMembers };
  const result = await db.collection('teams').insertOne(team);
  res.status(201).json({ _id: result.insertedId, ...team });
});

// PATCH /api/teams/:id  { name?, members? }
router.patch('/teams/:id', requireAdmin, async (req, res) => {
  const teamId = parseId(req.params.id, 'team id');
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
    .findOneAndUpdate({ _id: teamId }, { $set: changes }, { returnDocument: 'after' });
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

  const result = await db.collection('teams').deleteOne({ _id: teamId });
  if (result.deletedCount === 0) throw httpError(404, 'Team not found');

  // Deleting scores fires the Change Stream, which re-ranks the remaining teams.
  await db.collection('scores').deleteMany({ teamId });
  await db.collection('leaderboard').deleteMany({ teamId });
  await db.collection('feedback').deleteMany({ teamId });
  res.json({ message: 'Team deleted' });
});

module.exports = router;
