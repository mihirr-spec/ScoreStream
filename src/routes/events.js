// Events (admin only): create, list, read, change status/rubric, delete.

const express = require('express');
const { getDb } = require('../db');
const { requireAdmin, assertEventAccess, denyDemo } = require('../middleware/auth');
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
  // A demo admin only sees the demo event.
  const filter = req.demoEventId ? { demo: true } : {};
  const events = await getDb().collection('events').find(filter).sort({ createdAt: -1 }).toArray();
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
  const result = await getDb().collection('events').insertOne(event);
  res.status(201).json({ _id: result.insertedId, ...event });
});

// GET /api/events/:id
router.get('/events/:id', requireAdmin, async (req, res) => {
  const eventId = parseId(req.params.id, 'event id');
  assertEventAccess(req, eventId);
  const event = await getDb().collection('events').findOne({ _id: eventId });
  if (!event) throw httpError(404, 'Event not found');
  res.json(event);
});

// PATCH /api/events/:id  { status?, rubric? }
router.patch('/events/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  const eventId = parseId(req.params.id, 'event id');
  assertEventAccess(req, eventId);
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
  res.json(updated);
});

// DELETE /api/events/:id  -> deletes the event AND everything that references it.
// (MongoDB has no "ON DELETE CASCADE" like SQL, so we delete the related documents ourselves.)
router.delete('/events/:id', requireAdmin, async (req, res) => {
  denyDemo(req, 'delete the demo event');
  const db = getDb();
  const eventId = parseId(req.params.id, 'event id');

  const result = await db.collection('events').deleteOne({ _id: eventId });
  if (result.deletedCount === 0) throw httpError(404, 'Event not found');

  for (const name of ['teams', 'judges', 'scores', 'leaderboard', 'feedback']) {
    await db.collection(name).deleteMany({ eventId });
  }
  res.json({ message: 'Event and all its data deleted' });
});

module.exports = router;
