// Events (admin only): create, list, read, change status/rubric, delete.

const express = require('express');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess, denyDemo } = require('../middleware/auth');
const { recomputeLeaderboard } = require('../services/leaderboard');
const { generateEventFeedback } = require('../services/feedback');
const {
  httpError,
  parseId,
  isNonEmptyString,
  validateRubric,
  cleanRubric,
  EVENT_STATUSES,
} = require('../middleware/validate');

const router = express.Router();

// GET /api/events  -> all events, newest first
router.get('/events', requireAdmin, async (req, res) => {
  // A demo admin only sees the demo event, a registered admin only the events they created.
  const filter = req.demoEventId ? { demo: true } : req.adminId ? { ownerId: req.adminId } : {};
  // Each event also gets teamCount, judgeCount and scoreCount for the dashboard table.
  // A $lookup with a sub-pipeline that only $counts, so no team/judge documents are copied.
  const countOf = (from) => [
    { $lookup: { from, let: { id: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$eventId', '$$id'] } } }, { $count: 'n' }], as: from } },
  ];
  const events = await getDb()
    .collection('events')
    .aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      ...countOf('teams'),
      ...countOf('judges'),
      ...countOf('scores'),
      {
        $set: {
          teamCount: { $ifNull: [{ $first: '$teams.n' }, 0] },
          judgeCount: { $ifNull: [{ $first: '$judges.n' }, 0] },
          scoreCount: { $ifNull: [{ $first: '$scores.n' }, 0] },
        },
      },
      { $project: { teams: 0, judges: 0, scores: 0 } },
    ])
    .toArray();
  res.json(events);
});

// POST /api/events  { name, rubric, status? }
router.post('/events', requireAdmin, async (req, res) => {
  denyDemo(req, 'create new events');
  const { name, rubric, status = 'draft' } = req.body || {};

  if (!isNonEmptyString(name, 100)) throw httpError(400, 'name is required (max 100 characters)');
  if (!EVENT_STATUSES.includes(status)) throw httpError(400, 'status must be draft, live or closed');
  const rubricError = validateRubric(rubric);
  if (rubricError) throw httpError(400, rubricError);

  // The rubric is EMBEDDED inside the event document.
  const event = {
    name: name.trim(),
    status,
    rubric: cleanRubric(rubric),
    createdAt: new Date(),
  };
  // Remember who created it, so other admins can't see or change it.
  if (req.adminId) event.ownerId = req.adminId;
  const result = await getDb().collection('events').insertOne(event);
  res.status(201).json({ _id: result.insertedId, ...event });
});

// GET /api/events/:id
router.get('/events/:id', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.id, 'event id');
  await assertEventAccess(req, eventId);
  const event = await getDb().collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');
  res.json(event);
});

// PATCH /api/events/:id  { status?, rubric? }
router.patch('/events/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.id, 'event id');
  await assertEventAccess(req, eventId);
  const { status, rubric } = req.body || {};
  const changes = {};

  if (status !== undefined) {
    if (!EVENT_STATUSES.includes(status)) throw httpError(400, 'status must be draft, live or closed');
    changes.status = status;
  }

  if (rubric !== undefined) {
    const rubricError = validateRubric(rubric);
    if (rubricError) throw httpError(400, rubricError);
    // Changing the rubric after judges have scored would make old totals wrong.
    const scoreCount = await db.collection('scores').countDocuments({ eventId });
    if (scoreCount > 0) {
      throw httpError(409, 'Cannot change the rubric after scores have been submitted');
    }
    changes.rubric = cleanRubric(rubric);
  }

  if (Object.keys(changes).length === 0) {
    throw httpError(400, 'Send status and/or rubric to update');
  }

  // $set changes only the given fields. returnDocument: 'after' gives back the updated event.
  const updated = await db
    .collection('events')
    .findOneAndUpdate({ _id: eventId }, { $set: changes }, { returnDocument: 'after' });
  if (!updated) throw httpError(404, 'Event not found');

  // Closing the event = judging is over: lock in the final ranking and start writing
  // AI feedback for every team. Feedback runs in the BACKGROUND (one team at a time
  // can take a while with a real AI), so the admin gets an answer straight away.
  // Any status change also refreshes the ranking, so it can never stay out of date.
  if (changes.status) await recomputeLeaderboard(eventId);
  if (changes.status === 'closed') {
    // Ending the event expires every judge code of this event (and ends their sessions).
    await db.collection('judges').updateMany({ eventId, expiredAt: { $exists: false } }, { $set: { expiredAt: new Date() } });
    // Invitations nobody answered can't be accepted any more.
    await db.collection('invitations').deleteMany({ eventId, status: 'pending' });
    generateEventFeedback(eventId).catch((err) => console.error(`[feedback] event ${eventId}: ${err.message}`));
  }
  res.json(updated);
});

// DELETE /api/events/:id  -> deletes the event AND everything that references it.
// (MongoDB has no "ON DELETE CASCADE" like SQL, so we delete the related documents ourselves.)
router.delete('/events/:id', requireAdmin, async (req, res) => {
  denyDemo(req, 'delete the demo event');
  const db = getDb();
  const eventId = parseId(req.params.id, 'event id');
  await assertEventAccess(req, eventId);

  const result = await db.collection('events').deleteOne({ _id: eventId });
  if (result.deletedCount === 0) throw httpError(404, 'Event not found');

  for (const name of ['teams', 'judges', 'scores', 'leaderboard', 'feedback', 'invitations']) {
    await db.collection(name).deleteMany({ eventId });
  }
  res.json({ message: 'Event and all its data deleted' });
});

module.exports = router;
