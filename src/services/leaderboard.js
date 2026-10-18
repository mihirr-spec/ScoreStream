// Builds the leaderboard with ONE aggregation pipeline and saves it with $merge.
// The database does all the maths (average, count, ranking) - Node just starts it.

const { getDb } = require('../db');

// Returns the pipeline as a plain array so explain.js can reuse the same stages.
function buildLeaderboardPipeline(eventId, now) {
  return [
    // 1. $match: only this event's scores. Uses the { eventId: 1 } index (IXSCAN).
    //    Putting $match FIRST means every later stage works on fewer documents.
    { $match: { eventId } },

    // 2. $group: one result per team.
    //    $avg of each judge's total = the team's average score,
    //    $sum: 1 adds 1 per score document = how many judges scored the team.
    {
      $group: {
        _id: '$teamId',
        avgScore: { $avg: '$total' },
        judgesCount: { $sum: 1 },
      },
    },

    // Round BEFORE ranking, so two teams that both show 7.25 get the same rank.
    { $set: { avgScore: { $round: ['$avgScore', 2] } } },

    // 3. $lookup: a "join" with the teams collection to get each team's name
    //    (scores only store teamId, because we use references, not embedding).
    {
      $lookup: {
        from: 'teams',
        localField: '_id',
        foreignField: '_id',
        as: 'team',
      },
    },
    // $lookup returns an array; $unwind turns [team] into team.
    // A score whose team was deleted has an empty array and is dropped here.
    { $unwind: '$team' },

    // 4. $setWindowFields + $rank: rank teams by avgScore, highest first.
    //    $rank gives ties the same rank (1, 2, 2, 4) like a real competition.
    {
      $setWindowFields: {
        sortBy: { avgScore: -1 },
        output: { rank: { $rank: {} } },
      },
    },

    // Shape each row exactly like a leaderboard document.
    {
      $project: {
        _id: 0,
        eventId: { $literal: eventId },
        teamId: '$_id',
        teamName: '$team.name',
        avgScore: 1,
        judgesCount: 1,
        rank: 1,
        updatedAt: { $literal: now },
      },
    },

    // 5. $merge: write the rows into the leaderboard collection.
    //    on: [eventId, teamId] -> if that team's row exists, replace it; if not, insert it.
    //    (MongoDB needs the UNIQUE { eventId, teamId } index for this - see setup-db.js.)
    {
      $merge: {
        into: 'leaderboard',
        on: ['eventId', 'teamId'],
        whenMatched: 'replace',
        whenNotMatched: 'insert',
      },
    },
  ];
}

// Re-calculates one event's leaderboard inside MongoDB.
async function recomputeLeaderboard(eventId) {
  const db = getDb();
  const now = new Date();

  // $merge produces no output documents, but we still have to run the cursor.
  await db.collection('scores').aggregate(buildLeaderboardPipeline(eventId, now)).toArray();

  // $merge only adds/replaces rows. Any row it did NOT touch this time
  // (e.g. a team whose scores were all deleted) is out of date, so remove it.
  await db.collection('leaderboard').deleteMany({ eventId, updatedAt: { $lt: now } });
}

// Reads the saved leaderboard (best rank first).
async function getLeaderboard(eventId) {
  return getDb()
    .collection('leaderboard')
    .find({ eventId }, { projection: { _id: 0 } })
    .sort({ rank: 1, teamName: 1 })
    .toArray();
}

module.exports = { buildLeaderboardPipeline, recomputeLeaderboard, getLeaderboard };
