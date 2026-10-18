// AI feedback: after an event closes, summarise each team's judge comments.

const express = require('express');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess } = require('../middleware/auth');
const { httpError, parseId } = require('../middleware/validate');
const { generateTeamFeedback, usingRealAi } = require('../services/ai');

const router = express.Router();

// Free OpenRouter models allow ~20 requests/minute, so wait between teams.
const PAUSE_BETWEEN_TEAMS_MS = 3500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POST /api/events/:eventId/feedback/generate  (admin, event must be 'closed')
router.post('/events/:eventId/feedback/generate', requireAdmin, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.eventId, 'event id');
  assertEventAccess(req, eventId);

  const event = await db.collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');
  if (event.status !== 'closed') {
    throw httpError(409, 'Feedback can only be generated after the event is closed');
  }

  const teams = await db.collection('teams').find({ eventId }).sort({ name: 1 }).toArray();
  const results = [];

  // Team-by-team (one AI request at a time), NOT all at once - respects rate limits.
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    if (i > 0 && usingRealAi()) await wait(PAUSE_BETWEEN_TEAMS_MS);

    // Collect all non-empty judge comments for this team.
    const scores = await db
      .collection('scores')
      .find({ eventId, teamId: team._id }, { projection: { comment: 1 } })
      .toArray();
    const comments = scores.map((s) => s.comment).filter((c) => c && c.trim().length > 0);

    const ai = await generateTeamFeedback(team.name, comments);
    const feedback = {
      eventId,
      teamId: team._id,
      summary: ai.summary,
      strengths: ai.strengths,
      improvements: ai.improvements,
      sentiment: ai.sentiment,
      source: ai.source,
      generatedAt: new Date(),
    };

    // Upsert: replace this team's old feedback if it exists, otherwise insert.
    // (Unique { eventId, teamId } index guarantees only one per team.)
    await db
      .collection('feedback')
      .replaceOne({ eventId, teamId: team._id }, feedback, { upsert: true });
    results.push({ teamName: team.name, ...feedback });
  }

  res.json({ generated: results.length, feedback: results });
});

// GET /api/events/:eventId/feedback  (public, shown on the leaderboard page)
router.get('/events/:eventId/feedback', async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  const feedback = await getDb()
    .collection('feedback')
    .aggregate([
      { $match: { eventId } },
      { $lookup: { from: 'teams', localField: 'teamId', foreignField: '_id', as: 'team' } },
      { $set: { teamName: { $first: '$team.name' } } },
      { $project: { team: 0 } },
      { $sort: { teamName: 1 } },
    ])
    .toArray();
  res.json(feedback);
});

module.exports = router;
