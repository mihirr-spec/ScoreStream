// Judges. Admin creates/lists/deletes them; a logged-in judge can load their own info.

const express = require('express');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess, requireJudge, sha256, generateCode } = require('../middleware/auth');
const { httpError, parseId, isNonEmptyString, cleanCode, CODE_RULE } = require('../middleware/validate');
const { recomputeLeaderboard } = require('../services/leaderboard');

const router = express.Router();

// Loads a judge by id and checks this admin may manage its event.
async function findJudgeForAdmin(req, judgeId) {
  const judge = await getDb().collection('judges').findOne({ _id: judgeId }, { projection: { codeHash: 0 } });
  if (!judge) throw httpError(404, 'Judge not found');
  await assertEventAccess(req, judge.eventId);
  return judge;
}

// GET /api/events/:eventId/judges  -> never returns codeHash
router.get('/events/:eventId/judges', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);
  const judges = await getDb()
    .collection('judges')
    .find({ eventId }, { projection: { codeHash: 0 } }) // projection 0 = leave this field out
    .sort({ name: 1 })
    .toArray();
  res.json(judges);
});

// POST /api/events/:eventId/judges  { name, code? }  -> returns the plain code ONCE
// The admin may choose the code (e.g. "PANEL-01"); otherwise a random one is made.
router.post('/events/:eventId/judges', requireAdmin, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);
  const { name, code: chosenCode } = req.body || {};
  if (!isNonEmptyString(name, 100)) throw httpError(400, 'name is required (max 100 characters)');
  const customCode = cleanCode(chosenCode);
  if (customCode === null) throw httpError(400, CODE_RULE);

  const event = await db.collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');

  // Judges log in with their name, so two judges of one event can't share a name.
  const sameName = await db.collection('judges').findOne({ eventId, name: name.trim() }, { collation: { locale: 'en', strength: 2 } });
  if (sameName) throw httpError(409, `There is already a judge called "${sameName.name}" in this event`);

  // The admin's code, or a random 8-character one, e.g. "4F9A1C2B".
  const code = customCode || generateCode();

  // Store ONLY the hash. The plain code is returned in this response and then forgotten.
  const judge = { eventId, name: name.trim(), codeHash: sha256(code) };
  let result;
  try {
    result = await db.collection('judges').insertOne(judge);
  } catch (err) {
    // The unique codeHash index: some judge (in any event) already uses this code.
    if (err.code === 11000) throw httpError(409, 'That code is already in use - choose a different one');
    throw err;
  }

  res.status(201).json({
    _id: result.insertedId,
    eventId,
    name: judge.name,
    code,
    message: 'Save this code now - it will not be shown again',
  });
});

// POST /api/judges/:id/reset-code  -> new code (the old one stops working), shown ONCE
router.post('/judges/:id/reset-code', requireAdmin, async (req, res) => {
  const judgeId = parseId(req.params.id, 'judge id');
  await findJudgeForAdmin(req, judgeId);
  const code = generateCode();
  const judge = await getDb()
    .collection('judges')
    .findOneAndUpdate({ _id: judgeId }, { $set: { codeHash: sha256(code) } }, { returnDocument: 'after' });
  if (!judge) throw httpError(404, 'Judge not found');
  res.json({ _id: judge._id, name: judge.name, code, message: 'Save this code now - it will not be shown again' });
});

// DELETE /api/judges/:id  -> also removes that judge's scores
router.delete('/judges/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const judgeId = parseId(req.params.id, 'judge id');
  await findJudgeForAdmin(req, judgeId);

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

  // projection hides each team's secret code hash from the judge's browser.
  const teams = await db.collection('teams').find({ eventId }, { projection: { codeHash: 0 } }).sort({ name: 1 }).toArray();
  const myScores = await db.collection('scores').find({ eventId, judgeId: req.judge._id }).toArray();

  res.json({
    judge: { _id: req.judge._id, name: req.judge.name },
    event: { _id: event._id, name: event.name, status: event.status, rubric: event.rubric, demo: event.demo === true },
    teams,
    myScores,
  });
});

module.exports = router;
