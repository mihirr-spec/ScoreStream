// Generates AI feedback for every team of an event (used when an event is closed).
// Called automatically by PATCH /events/:id when the status becomes 'closed', and
// by the admin's "Generate feedback" button.

const { getDb } = require('../db');
const { generateTeamFeedback, usingRealAi } = require('./ai');
const sse = require('./sse');

// Free OpenRouter models allow ~20 requests/minute, so wait between teams.
const PAUSE_BETWEEN_TEAMS_MS = 3500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// eventId (string) -> the promise of the run in progress. If a second request
// comes in while one is running, it gets the SAME promise instead of starting
// another run (two runs upserting the same team at once could clash).
const running = new Map();

async function runForEvent(eventId) {
  const db = getDb();
  const event = await db.collection('events').findOne({ _id: eventId }, { projection: { rubric: 1 } });
  const teamCount = await db.collection('teams').countDocuments({ eventId });
  const teams = await db.collection('teams').find({ eventId }).sort({ name: 1 }).toArray();
  const results = [];

  // Team-by-team (one AI request at a time), NOT all at once - respects rate limits.
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    if (i > 0 && usingRealAi()) await wait(PAUSE_BETWEEN_TEAMS_MS);

    // Collect all non-empty judge comments for this team.
    const scores = await db
      .collection('scores')
      .find({ eventId, teamId: team._id }, { projection: { comment: 1, criteria: 1 } })
      .toArray();
    const comments = scores.map((s) => s.comment).filter((c) => c && c.trim().length > 0);

    // Give the AI the numbers too: final rank/average and the average mark per criterion.
    const standing = await db.collection('leaderboard').findOne({ eventId, teamId: team._id });
    const parts = [];
    if (standing) parts.push(`average ${standing.avgScore}/10 from ${standing.judgesCount} judge(s), rank ${standing.rank} of ${teamCount}`);
    for (const item of event ? event.rubric : []) {
      const marks = scores.map((s) => s.criteria?.[item.key]).filter((m) => typeof m === 'number');
      if (marks.length) parts.push(`${item.label} ${(marks.reduce((a, b) => a + b, 0) / marks.length).toFixed(1)}/${item.max}`);
    }

    const ai = await generateTeamFeedback(team.name, comments, parts.join('; '));
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
    // The team's open page shows its feedback the moment it is saved.
    sse.broadcast(eventId.toString(), 'feedback', { teamId: team._id.toString() });
    results.push({ teamName: team.name, ...feedback });
  }

  return results;
}

function generateEventFeedback(eventId) {
  const key = eventId.toString();
  if (!running.has(key)) {
    running.set(key, runForEvent(eventId).finally(() => running.delete(key)));
  }
  return running.get(key);
}

module.exports = { generateEventFeedback };
