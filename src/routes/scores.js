// Scores. Judges submit and edit; admin can list all scores of an event.
// Note: these routes do NOT update the leaderboard themselves. They only write to
// "scores" - the Change Stream (services/changeStream.js) notices and does the rest.

const express = require('express');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess, requireJudge, findJudgeSeat } = require('../middleware/auth');
const { httpError, parseId } = require('../middleware/validate');
const { validateCriteria, calculateTotal } = require('../services/scoring');

const router = express.Router();

// Loads an event and checks scoring is currently allowed.
async function getLiveEvent(eventId) {
  const event = await getDb().collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');
  if (event.status !== 'live') {
    throw httpError(403, `Scoring is closed: this event is "${event.status}", not "live"`);
  }
  return event;
}

// Checks criteria + comment and returns the fields to save.
function buildScoreFields(event, body) {
  const { criteria, comment = '' } = body || {};

  const criteriaError = validateCriteria(event.rubric, criteria);
  if (criteriaError) throw httpError(400, criteriaError);
  if (typeof comment !== 'string' || comment.length > 1000) {
    throw httpError(400, 'comment must be text of at most 1000 characters');
  }

  // Copy only the rubric keys (in rubric order) - nothing extra gets stored.
  const cleanCriteria = {};
  for (const item of event.rubric) cleanCriteria[item.key] = criteria[item.key];

  return {
    criteria: cleanCriteria,
    total: calculateTotal(event.rubric, cleanCriteria),
    comment: comment.trim(),
  };
}

// POST /api/scores  { teamId, criteria, comment }
router.post('/scores', requireJudge, async (req, res) => {
  const db = getDb();
  const teamId = parseId((req.body || {}).teamId, 'teamId');
  const team = await db.collection('teams').findOne({ _id: teamId }, { projection: { eventId: 1 } });
  if (!team) throw httpError(404, 'Team not found');

  // A judge can only score teams of events they accepted (their seat in that event).
  const seat = await findJudgeSeat(req, team.eventId);
  const event = await getLiveEvent(team.eventId);

  const score = {
    eventId: event._id,
    teamId,
    judgeId: seat._id,
    ...buildScoreFields(event, req.body),
    submittedAt: new Date(),
  };

  try {
    const result = await db.collection('scores').insertOne(score);
    res.status(201).json({ _id: result.insertedId, ...score });
  } catch (err) {
    // 11000 = duplicate key. The UNIQUE { eventId, teamId, judgeId } index blocked
    // a second score from this judge for this team. The DATABASE enforces this rule,
    // so it holds even if two requests arrive at the same moment.
    if (err.code === 11000) {
      throw httpError(409, 'You have already scored this team. Edit your existing score instead.');
    }
    throw err;
  }
});

// PUT /api/scores/:id  { criteria, comment }  -> judge edits their own score
router.put('/scores/:id', requireJudge, async (req, res) => {
  const db = getDb();
  const scoreId = parseId(req.params.id, 'score id');
  const existing = await db.collection('scores').findOne({ _id: scoreId }, { projection: { eventId: 1 } });
  if (!existing) throw httpError(404, 'Score not found (or it is not yours)');
  const seat = await findJudgeSeat(req, existing.eventId);
  const event = await getLiveEvent(existing.eventId);

  const fields = buildScoreFields(event, req.body);

  // The filter includes judgeId, so a judge can never edit someone else's score.
  const updated = await db.collection('scores').findOneAndUpdate(
    { _id: scoreId, judgeId: seat._id, eventId: event._id },
    { $set: { ...fields, submittedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!updated) throw httpError(404, 'Score not found (or it is not yours)');
  res.json(updated);
});

// GET /api/events/:eventId/scores  (admin) -> every score, with team and judge names
router.get('/events/:eventId/scores', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);

  const scores = await getDb()
    .collection('scores')
    .aggregate([
      { $match: { eventId } },
      // Two $lookups "join" in the team name and the judge name.
      { $lookup: { from: 'teams', localField: 'teamId', foreignField: '_id', as: 'team' } },
      { $lookup: { from: 'judges', localField: 'judgeId', foreignField: '_id', as: 'judge' } },
      {
        $project: {
          teamId: 1,
          judgeId: 1,
          criteria: 1,
          total: 1,
          comment: 1,
          submittedAt: 1,
          // $first takes the single element out of the $lookup array.
          teamName: { $first: '$team.name' },
          judgeName: { $first: '$judge.name' },
        },
      },
      { $sort: { teamName: 1, judgeName: 1 } },
    ])
    .toArray();
  res.json(scores);
});

module.exports = router;
