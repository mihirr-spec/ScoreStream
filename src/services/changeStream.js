// Change Stream on the scores collection.
// MongoDB tells us (pushes to us) every time a score is inserted, updated,
// replaced or deleted - no polling. Change Streams read the replica set's oplog,
// which is why they need a replica set (Atlas clusters always are one).
//
// On every change: recompute that event's leaderboard -> push it to browsers (SSE).
//
// IMPORTANT: this handler NEVER writes to the scores collection. If it did, that write
// would create a new change event, which would run this handler again... forever.
// It only writes to the leaderboard collection, which we are not watching.

const { getDb } = require('../db');
const { recomputeLeaderboard, getLeaderboard } = require('./leaderboard');
const sse = require('./sse');

let stream = null;
// Changes are handled one at a time, in order, by chaining promises.
// This stops two recomputes of the same event racing each other.
let queue = Promise.resolve();

// Recompute + broadcast for one event.
async function refreshEvent(eventId) {
  await recomputeLeaderboard(eventId);
  const rows = await getLeaderboard(eventId);
  sse.broadcast(eventId.toString(), 'leaderboard', rows);
  console.log(`[changeStream] leaderboard updated for event ${eventId} (${rows.length} teams)`);
}

async function handleChange(change) {
  const db = getDb();
  // For insert/update/replace we have the full document (updateLookup below),
  // so we know exactly which event changed.
  if (change.fullDocument) {
    await refreshEvent(change.fullDocument.eventId);
    return;
  }

  // A DELETE only carries the deleted _id, not the document, so we can't know
  // its event. Safe option: recompute every event that is currently 'live'.
  // (Same if an update's document was deleted before we could look it up.)
  const liveEvents = await db.collection('events').find({ status: 'live' }, { projection: { _id: 1 } }).toArray();
  for (const event of liveEvents) {
    await refreshEvent(event._id);
  }
}

function startScoreWatcher() {
  const scores = getDb().collection('scores');

  // The $match here filters change events INSIDE MongoDB, so we only receive these 4 types.
  // fullDocument: 'updateLookup' = for updates, also send the whole updated document
  // (by default an update event only contains the changed fields).
  stream = scores.watch(
    [{ $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } }],
    { fullDocument: 'updateLookup' }
  );

  stream.on('change', (change) => {
    queue = queue
      .then(() => handleChange(change))
      .catch((err) => console.error('[changeStream] failed to refresh leaderboard:', err.message));
  });

  stream.on('error', (err) => {
    console.error('[changeStream] stream error:', err.message);
  });

  console.log('[changeStream] watching scores for changes');
  return stream;
}

async function stopScoreWatcher() {
  if (stream) {
    await stream.close();
    stream = null;
  }
  // Let any change that is still being handled finish first.
  await queue;
}

module.exports = { startScoreWatcher, stopScoreWatcher };
