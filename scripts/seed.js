// Fills the database with demo data:
//   - "Demo Hackathon 2026" (LIVE): 5 teams, 3 judges. Judges 1 and 2 have scored every
//     team; Judge 3 has scored nobody, so you can log in as them and score live in the demo.
//   - "Spring Demo Day 2026" (CLOSED): 3 teams, 2 judges, all scored with comments,
//     ready for AI feedback generation.
// Running it again first deletes the old demo events, so it is safe to repeat.
//
// Run: npm run setup-db   (once)   then   npm run seed

const { connectDb, getDb, closeDb } = require('../src/db');
const { sha256 } = require('../src/middleware/auth');
const { calculateTotal } = require('../src/services/scoring');
const { recomputeLeaderboard } = require('../src/services/leaderboard');

const demoEvents = [
  {
    name: 'Demo Hackathon 2026',
    status: 'live',
    rubric: [
      { key: 'innovation', label: 'Innovation', max: 10, weight: 0.3 },
      { key: 'design', label: 'Design', max: 10, weight: 0.4 },
      { key: 'execution', label: 'Execution', max: 10, weight: 0.3 },
    ],
    teams: [
      { name: 'Byte Bandits', members: ['Asha', 'Rohan'] },
      { name: 'Null Pointers', members: ['Kabir', 'Meera', 'Dev'] },
      { name: 'Query Queens', members: ['Isha', 'Zoya'] },
      { name: 'Stack Smashers', members: ['Arjun', 'Neel'] },
      { name: 'The Indexers', members: ['Priya', 'Sam', 'Tara'] },
    ],
    // Plain codes are only in this demo script so you can log in. The DB stores hashes.
    judges: [
      { name: 'Judge One', code: 'JUDGE001' },
      { name: 'Judge Two', code: 'JUDGE002' },
      { name: 'Judge Three', code: 'JUDGE003' },
    ],
    // scores[judgeIndex][teamIndex] = [marks in rubric order, comment]
    scores: [
      [
        [[8, 7, 9], 'Great idea and solid execution. Design could be cleaner.'],
        [[6, 8, 6], 'Nice clean design, but the core feature is incomplete.'],
        [[9, 9, 8], 'Excellent and impressive demo, very creative use of change streams.'],
        [[5, 5, 6], 'Idea is weak and the UI is confusing. Needs more work.'],
        [[7, 6, 8], 'Good technical depth, the presentation lacks clarity.'],
      ],
      [
        [[7, 8, 8], 'Strong team, clear pitch.'],
        [[7, 7, 5], 'Good design, some bugs during the demo.'],
        [[8, 9, 9], 'Polished and well thought out.'],
        [[6, 4, 5], 'Unclear problem statement, poor slides.'],
        [[8, 7, 7], 'Solid indexing work, impressive query speed.'],
      ],
    ],
  },
  {
    name: 'Spring Demo Day 2026',
    status: 'closed',
    rubric: [
      { key: 'idea', label: 'Idea', max: 10, weight: 0.5 },
      { key: 'pitch', label: 'Pitch', max: 5, weight: 0.5 },
    ],
    teams: [
      { name: 'Green Route', members: ['Nina', 'Omar'] },
      { name: 'MediTrack', members: ['Lea', 'Vik'] },
      { name: 'StudyBuddy', members: ['Ana', 'Raj', 'Kim'] },
    ],
    judges: [
      { name: 'Prof. Rao', code: 'SPRING01' },
      { name: 'Ms. Khan', code: 'SPRING02' },
    ],
    scores: [
      [
        [[9, 4], 'Excellent real-world impact and a clear, confident pitch.'],
        [[6, 3], 'Good idea but the pitch was slow and missing a demo.'],
        [[7, 5], 'Creative concept and a great, energetic pitch.'],
      ],
      [
        [[8, 5], 'Strong data story, well presented.'],
        [[5, 2], 'Weak market research and an unclear business model.'],
        [[7, 4], 'Nice UI, needs a plan for scaling.'],
      ],
    ],
  },
];

async function seedEvent(db, demo) {
  // Remove any previous copy of this demo event and all its related documents.
  const old = await db.collection('events').findOne({ name: demo.name });
  if (old) {
    await db.collection('events').deleteOne({ _id: old._id });
    for (const name of ['teams', 'judges', 'scores', 'leaderboard', 'feedback']) {
      await db.collection(name).deleteMany({ eventId: old._id });
    }
  }

  const { insertedId: eventId } = await db.collection('events').insertOne({
    name: demo.name,
    status: demo.status,
    rubric: demo.rubric,
    createdAt: new Date(),
  });

  // insertMany returns insertedIds as { 0: id, 1: id, ... } in the same order.
  const teamResult = await db
    .collection('teams')
    .insertMany(demo.teams.map((t) => ({ eventId, name: t.name, members: t.members })));
  const judgeResult = await db
    .collection('judges')
    .insertMany(demo.judges.map((j) => ({ eventId, name: j.name, codeHash: sha256(j.code) })));

  const scoreDocs = [];
  demo.scores.forEach((judgeScores, judgeIndex) => {
    judgeScores.forEach(([marks, comment], teamIndex) => {
      const criteria = {};
      demo.rubric.forEach((item, i) => (criteria[item.key] = marks[i]));
      scoreDocs.push({
        eventId,
        teamId: teamResult.insertedIds[teamIndex],
        judgeId: judgeResult.insertedIds[judgeIndex],
        criteria,
        total: calculateTotal(demo.rubric, criteria),
        comment,
        submittedAt: new Date(),
      });
    });
  });
  await db.collection('scores').insertMany(scoreDocs);

  // Build the leaderboard now, so it exists even if the server is not running.
  await recomputeLeaderboard(eventId);

  console.log(`\n${demo.name}  [${demo.status}]  id=${eventId}`);
  console.log(`  ${demo.teams.length} teams, ${scoreDocs.length} scores`);
  console.log('  Judge codes:', demo.judges.map((j) => `${j.name} = ${j.code}`).join(', '));
}

async function main() {
  await connectDb();
  const db = getDb();

  const collections = await db.listCollections({ name: 'scores' }).toArray();
  if (collections.length === 0) {
    throw new Error('Collections not found. Run "npm run setup-db" first.');
  }

  for (const demo of demoEvents) {
    await seedEvent(db, demo);
  }
  console.log('\nSeed complete.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
