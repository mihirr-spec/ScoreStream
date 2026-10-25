// The shared demo event used by the one-click demo accounts.
// It is a normal event stored in MongoDB (marked demo: true) with 3 teams and 2 judges:
//   - "Demo Judge"  -> the account visitors log in as (starts with no scores, so they can rate)
//   - "Guest Judge" -> has already scored all 3 teams, so the leaderboard is never empty
// It is created the first time someone uses a demo account.

const { getDb } = require('../db');
const { sha256, generateCode, generateTeamCode, hashPassword } = require('../middleware/auth');
const { calculateTotal } = require('./scoring');
const { recomputeLeaderboard } = require('./leaderboard');

const DEMO_RUBRIC = [
  { key: 'innovation', label: 'Innovation', max: 10, weight: 0.3 },
  { key: 'design', label: 'Design', max: 10, weight: 0.4 },
  { key: 'execution', label: 'Execution', max: 10, weight: 0.3 },
];

const DEMO_TEAMS = [
  { name: 'Team Phoenix', members: ['Aarav', 'Diya'], guestMarks: [8, 7, 8], comment: 'Strong idea and a clear, confident demo.' },
  { name: 'Team Nova', members: ['Kabir', 'Anaya', 'Ishan'], guestMarks: [7, 8, 6], comment: 'Beautiful design, but some features felt incomplete.' },
  { name: 'Team Orbit', members: ['Riya', 'Vivaan'], guestMarks: [6, 6, 7], comment: 'Solid execution, the idea needs a sharper focus.' },
];

// Creates the demo event and everything in it.
async function createDemoEvent() {
  const db = getDb();
  const { insertedId: eventId } = await db.collection('events').insertOne({
    name: 'ScoreStream Demo Event',
    status: 'live',
    rubric: DEMO_RUBRIC,
    createdAt: new Date(),
    demo: true,
  });

  // Demo accounts log in with a button, so each one gets a random password nobody knows.
  const teams = await db.collection('teams').insertMany(
    DEMO_TEAMS.map((t) => ({ eventId, name: t.name, members: t.members, joinedAt: new Date() }))
  );
  for (const teamId of Object.values(teams.insertedIds)) {
    await ensureTeamAccount(await db.collection('teams').findOne({ _id: teamId }));
  }
  const judges = await db.collection('judges').insertMany([
    { eventId, name: 'Demo Judge', codeHash: sha256(generateCode()) },
    { eventId, name: 'Guest Judge', codeHash: sha256(generateCode()) },
  ]);

  // The Guest Judge's scores (judges.insertedIds[1]).
  await db.collection('scores').insertMany(
    DEMO_TEAMS.map((t, i) => {
      const criteria = {};
      DEMO_RUBRIC.forEach((item, k) => (criteria[item.key] = t.guestMarks[k]));
      return {
        eventId,
        teamId: teams.insertedIds[i],
        judgeId: judges.insertedIds[1],
        criteria,
        total: calculateTotal(DEMO_RUBRIC, criteria),
        comment: t.comment,
        submittedAt: new Date(),
      };
    })
  );
  await recomputeLeaderboard(eventId);
  return eventId;
}

// Makes sure a team in an event has a team account (demo teams, and teams created
// before team accounts existed). Returns the account id.
async function ensureTeamAccount(team) {
  if (team.accountId) return team.accountId;
  const db = getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      const { insertedId } = await db.collection('teamAccounts').insertOne({
        name: team.name,
        members: team.members,
        code: generateTeamCode(),
        passwordHash: hashPassword(generateCode() + generateCode()),
        createdAt: new Date(),
        demo: true,
      });
      await db.collection('teams').updateOne({ _id: team._id }, { $set: { accountId: insertedId } });
      return insertedId;
    } catch (err) {
      if (err.code !== 11000 || attempt >= 5) throw err;
    }
  }
}

// Returns the demo event, creating it if it does not exist yet.
async function ensureDemoEvent() {
  const db = getDb();
  const existing = await db.collection('events').findOne({ demo: true });
  if (existing) return existing;

  try {
    await createDemoEvent();
  } catch (err) {
    // 11000: another visitor created it a moment ago (unique_demo_event index). Use theirs.
    if (err.code !== 11000) throw err;
  }
  return db.collection('events').findOne({ demo: true });
}

// Deletes the demo event and everything that references it (used by the seed script).
async function resetDemoEvent() {
  const db = getDb();
  const old = await db.collection('events').findOne({ demo: true });
  if (old) {
    await db.collection('events').deleteOne({ _id: old._id });
    for (const name of ['teams', 'judges', 'scores', 'leaderboard', 'feedback', 'invitations']) {
      await db.collection(name).deleteMany({ eventId: old._id });
    }
    await db.collection('teamAccounts').deleteMany({ demo: true });
  }
  return ensureDemoEvent();
}

module.exports = { ensureDemoEvent, resetDemoEvent, ensureTeamAccount };
