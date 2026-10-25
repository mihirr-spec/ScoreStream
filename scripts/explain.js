// Shows HOW MongoDB answers our two most important queries:
//   COLLSCAN = collection scan -> reads every document (slow on big data)
//   IXSCAN   = index scan      -> uses an index to jump to matching documents (fast)
//
// Screenshot flow for the report:
//   1. npm run explain -- --drop-indexes   (removes scores indexes -> shows COLLSCAN)
//   2. npm run setup-db                    (puts the indexes back)
//   3. npm run explain                     (shows IXSCAN)
// Create an event with a few scores first so there is real data - then COLLSCAN reads
// ALL scores while IXSCAN reads only the chosen event's scores.

const { ObjectId } = require('mongodb');
const { connectDb, getDb, closeDb } = require('../src/db');
const { buildLeaderboardPipeline } = require('../src/services/leaderboard');

// Walks the explain output (a nested object) and collects every "stage" name,
// e.g. ['FETCH', 'IXSCAN']. We skip "rejectedPlans" because those plans were NOT used.
function collectStages(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectStages(item, found);
  } else if (node && typeof node === 'object') {
    if (typeof node.stage === 'string') found.push(node.stage);
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'rejectedPlans') collectStages(value, found);
    }
  }
  return found;
}

// Finds the first value stored under `wantedKey` anywhere in the explain output.
// The explain layout differs between find() and aggregate(), so we search instead of
// hard-coding a path.
function findValue(node, wantedKey) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const result = findValue(item, wantedKey);
      if (result !== undefined) return result;
    }
  } else if (node && typeof node === 'object') {
    if (wantedKey in node) return node[wantedKey];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'rejectedPlans') continue;
      const result = findValue(value, wantedKey);
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

function printReport(title, explainOutput) {
  // Keep each stage name once. Lowercase names (scan, seek, nlj...) are internal steps
  // of MongoDB's newer query engine (SBE) - the UPPERCASE ones are the classic plan stages.
  const stages = [...new Set(collectStages(explainOutput).filter((s) => s === s.toUpperCase()))];
  const usedIndex = stages.some((s) => s.includes('IXSCAN'));
  const usedCollScan = stages.includes('COLLSCAN');

  console.log('\n==================================================');
  console.log(title);
  console.log('==================================================');
  console.log('Plan stages        :', stages.join(' -> ') || '(none found)');
  if (usedIndex) {
    console.log('RESULT             : IXSCAN (index scan) using index', findValue(explainOutput, 'indexName'));
  } else if (usedCollScan) {
    console.log('RESULT             : COLLSCAN (full collection scan, no index used)');
  } else {
    console.log('RESULT             : could not detect scan type');
  }
  console.log('Documents returned :', findValue(explainOutput, 'nReturned'));
  console.log('Index keys examined:', findValue(explainOutput, 'totalKeysExamined'));
  console.log('Documents examined :', findValue(explainOutput, 'totalDocsExamined'));
  console.log('Time (ms)          :', findValue(explainOutput, 'executionTimeMillis'));
}

async function main() {
  await connectDb();
  const db = getDb();
  const scores = db.collection('scores');

  // Optional "before" mode: drop the scores indexes so we can see a COLLSCAN.
  if (process.argv.includes('--drop-indexes')) {
    await scores.dropIndexes(); // drops every index except the built-in _id index
    console.log('Dropped scores indexes (kept _id). Run "npm run setup-db" afterwards to restore them!');
  }

  const indexNames = (await scores.indexes()).map((ix) => ix.name);
  console.log('Indexes on scores right now:', indexNames.join(', '));
  console.log('Documents in scores        :', await scores.countDocuments());

  // Use a real event if one exists (prefer a live one), otherwise a random id (the plan is still shown).
  const event = await db.collection('events').findOne({}, { projection: { _id: 1 }, sort: { status: -1 } });
  const eventId = event ? event._id : new ObjectId();
  console.log('Explaining queries for eventId:', eventId.toString());

  // Query 1: all scores of one event.
  // 'executionStats' = actually run the query and report what it did.
  const findExplain = await scores.find({ eventId }).explain('executionStats');
  printReport('Query 1: scores.find({ eventId })', findExplain);

  // Query 2: the REAL leaderboard aggregation from services/leaderboard.js.
  // We remove the last stage ($merge) because explain should only DESCRIBE the
  // query, not write to the leaderboard collection. The index decision is made
  // by the first stage, $match.
  const pipeline = buildLeaderboardPipeline(eventId, new Date()).slice(0, -1);
  const aggExplain = await scores.aggregate(pipeline).explain('executionStats');
  printReport('Query 2: leaderboard aggregation ($match -> $group -> $lookup -> $setWindowFields)', aggExplain);
}

main()
  .catch((err) => {
    console.error('Explain failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
