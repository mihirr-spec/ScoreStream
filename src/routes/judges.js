// Judges. Admin creates/lists/deletes them; a logged-in judge can load their own info.

const crypto = require('crypto');
const express = require('express');
const { getDb } = require('../db');
const { requireAdmin, requireJudge, sha256 } = require('../middleware/auth');
const { httpError, parseId, isNonEmptyString } = require('../middleware/validate');
const { recomputeLeaderboard } = require('../services/leaderboard');

const router = express.Router();

// GET /api/events/:eventId/judges  -> never returns codeHash
router.get('/events/:eventId/judges', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  const judges = await getDb()
    .collection('judges')
    .find({ eventId }, { projection: { codeHash: 0 } }) // projection 0 = leave this field out
    .sort({ name: 1 })
    .toArray();
  res.json(judges);
});

// POST /api/events/:eventId/judges  { name }  -> returns the plain code ONCE
router.post('/events/:eventId/judges', requireAdmin, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.eventId, 'event id');
  const { name } = req.body || {};
  if (!isNonEmptyString(name, 100)) throw httpError(400, 'name is required (max 100 characters)');

  const event = await db.collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');

  // Random 8-character code, e.g. "4F9A1C2B". crypto.randomBytes is cryptographically random.
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();

  // Store ONLY the hash. The plain code is returned in this response and then forgotten.
  const judge = { eventId, name: name.trim(), codeHash: sha256(code) };
  const result = await db.collection('judges').insertOne(judge);

  res.status(201).json({
    _id: result.insertedId,
    eventId,
    name: judge.name,
    code,
    message: 'Save this code now - it will not be shown again',
  });
});

// DELETE /api/judges/:id  -> also removes that judge's scores
router.delete('/judges/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const judgeId = parseId(req.params.id, 'judge id');

  const judge = await db.collection('judges').findOneAndDelete({ _id: judgeId });
  if (!judge) throw httpError(404, 'Judge not found');

  await db.collection('scores').deleteMany({ judgeId });
  // The Change Stream only re-ranks LIVE events after a delete, so refresh this
  // event directly too (it might be draft or closed).
  await recomputeLeaderboard(judge.eventId);
  res.json({ message: 'Judge and their scores deleted' });
});

// GET /api/judge/me  -> what the judge page needs: event + rubric, teams, my scores
router.get('/judge/me', requireJudge, async (req, res) => {
  const db = getDb();
  const eventId = req.judge.eventId;

  const event = await db.collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');

  const teams = await db.collection('teams').find({ eventId }).sort({ name: 1 }).toArray();
  const myScores = await db.collection('scores').find({ eventId, judgeId: req.judge._id }).toArray();

  res.json({
    judge: { _id: req.judge._id, name: req.judge.name },
    event: { _id: event._id, name: event.name, status: event.status, rubric: event.rubric },
    teams,
    myScores,
  });
});

module.exports = router;
