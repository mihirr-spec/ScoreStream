// AI feedback: after an event closes, summarise each team's judge comments.

const express = require('express');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess } = require('../middleware/auth');
const { httpError, parseId } = require('../middleware/validate');
const { generateEventFeedback } = require('../services/feedback');

const router = express.Router();

// POST /api/events/:eventId/feedback/generate  (admin, event must be 'closed')
router.post('/events/:eventId/feedback/generate', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  await assertEventAccess(req, eventId);

  const event = await getDb().collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');
  if (event.status !== 'closed') {
    throw httpError(409, 'Feedback can only be generated after the event is closed');
  }

  // If closing the event already started generating, this waits for that same run.
  const results = await generateEventFeedback(eventId);
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
