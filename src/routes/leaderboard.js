// Public leaderboard: a normal JSON route, plus a live SSE stream.

const express = require('express');
const { getDb } = require('../db');
const { httpError, parseId } = require('../middleware/validate');
const { getLeaderboard } = require('../services/leaderboard');
const sse = require('../services/sse');

const router = express.Router();

// Shared check: the event must exist. Only public fields are returned (no rubric weights etc. needed).
async function findPublicEvent(eventId) {
  const event = await getDb()
    .collection('events')
    .findOne({ _id: eventId }, { projection: { name: 1, status: 1 } });
  if (!event) throw httpError(404, 'Event not found');
  return event;
}

// GET /api/leaderboard/events  -> live + closed events, so the public page can show a list.
router.get('/leaderboard/events', async (req, res) => {
  const events = await getDb()
    .collection('events')
    .find({ status: { $in: ['live', 'closed'] } }, { projection: { name: 1, status: 1 } })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(events);
});

// GET /api/events/:eventId/leaderboard
router.get('/events/:eventId/leaderboard', async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  const event = await findPublicEvent(eventId);
  res.json({ event, rows: await getLeaderboard(eventId) });
});

// GET /api/events/:eventId/stream  (Server-Sent Events)
router.get('/events/:eventId/stream', async (req, res) => {
  const eventId = parseId(req.params.eventId, 'event id');
  await findPublicEvent(eventId);

  // These headers turn a normal response into an SSE stream that stays open.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // Send the current leaderboard straight away, so the page isn't empty.
  sse.sendTo(res, 'leaderboard', await getLeaderboard(eventId));

  const key = eventId.toString();
  sse.addClient(key, res);

  // A comment line (starts with ":") every 25s keeps proxies from closing an idle connection.
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);

  // Browser closed the tab -> stop sending to it.
  req.on('close', () => {
    clearInterval(heartbeat);
    sse.removeClient(key, res);
  });
});

module.exports = router;
