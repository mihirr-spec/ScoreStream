// API tests using Node's built-in test runner:  npm test
//
// They run against a SEPARATE database "<DB_NAME>_test" (dropped at the start and end),
// so your demo data is never touched. They need the same Atlas cluster as the app
// (a replica set, because test 4 relies on the Change Stream).
// AI_FORCE_MOCK=1 makes test 6 use the mock AI, so no network call to OpenRouter.

// These must be set BEFORE config.js is loaded (dotenv never overwrites existing values).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
process.env.DB_NAME = `${process.env.DB_NAME || 'judging_system'}_test`;
process.env.AI_FORCE_MOCK = '1';

const { test, before, after } = require('node:test');
const { ObjectId } = require('mongodb');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { connectDb, getDb, closeDb } = require('../src/db');
const { setupDatabase } = require('../scripts/setup-db');
const app = require('../src/app');
const { startScoreWatcher, stopScoreWatcher } = require('../src/services/changeStream');

let server;
let baseUrl;
let adminToken;
let judgeToken;
let judge2Token;
let eventId;
let teamA;
let teamB;
let firstScoreId;

// Small helper: call our API and return { status, body }.
async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// The leaderboard is updated asynchronously by the Change Stream,
// so keep checking until `check` returns true (or give up after 15 seconds).
async function waitFor(check, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the leaderboard to update');
}

async function leaderboardRank(teamId) {
  const { body } = await api('GET', `/api/events/${eventId}/leaderboard`);
  const row = body.rows.find((r) => r.teamId === teamId);
  return row ? row.rank : null;
}

before(async () => {
  await connectDb();
  await getDb().dropDatabase(); // start from an empty test database
  await setupDatabase(getDb()); // same validators + indexes as the real app
  startScoreWatcher();

  // Port 0 = let the OS pick any free port.
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  adminToken = (await api('POST', '/api/auth/admin-login', { body: { username: config.adminUsername, password: config.adminPassword } })).body.token;

  const event = await api('POST', '/api/events', {
    token: adminToken,
    body: {
      name: 'Test Event',
      status: 'live',
      rubric: [
        { key: 'innovation', label: 'Innovation', max: 10, weight: 0.3 },
        { key: 'design', label: 'Design', max: 10, weight: 0.4 },
        { key: 'execution', label: 'Execution', max: 10, weight: 0.3 },
      ],
    },
  });
  eventId = event.body._id;

  teamA = (await api('POST', `/api/events/${eventId}/teams`, { token: adminToken, body: { name: 'Team A', members: ['Ann'] } })).body._id;
  teamB = (await api('POST', `/api/events/${eventId}/teams`, { token: adminToken, body: { name: 'Team B', members: ['Ben'] } })).body._id;

  const judge1 = await api('POST', `/api/events/${eventId}/judges`, { token: adminToken, body: { name: 'Judge 1' } });
  const judge2 = await api('POST', `/api/events/${eventId}/judges`, { token: adminToken, body: { name: 'Judge 2' } });
  judgeToken = (await api('POST', '/api/auth/judge-login', { body: { name: 'Judge 1', code: judge1.body.code } })).body.token;
  judge2Token = (await api('POST', '/api/auth/judge-login', { body: { name: 'judge 2', code: judge2.body.code } })).body.token;
});

after(async () => {
  await stopScoreWatcher();
  await new Promise((resolve) => server.close(resolve));
  await getDb().dropDatabase();
  await closeDb();
});

test('1. judge submits valid marks -> score saved with the correct total', async () => {
  const res = await api('POST', '/api/scores', {
    token: judgeToken,
    body: { teamId: teamA, criteria: { innovation: 8, design: 7, execution: 9 }, comment: 'Great work, clear demo' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.total, 7.9); // 10 * (0.8*0.3 + 0.7*0.4 + 0.9*0.3)
  firstScoreId = res.body._id;

  const saved = await getDb().collection('scores').countDocuments({});
  assert.equal(saved, 1);
});

test('2. marks above the allowed max -> rejected with an error', async () => {
  const res = await api('POST', '/api/scores', {
    token: judgeToken,
    body: { teamId: teamB, criteria: { innovation: 11, design: 7, execution: 9 }, comment: '' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /between 0 and 10/);
});

test('3. same judge scores the same team twice -> blocked by the unique index', async () => {
  const res = await api('POST', '/api/scores', {
    token: judgeToken,
    body: { teamId: teamA, criteria: { innovation: 5, design: 5, execution: 5 } },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already scored/);

  // Prove it is the DATABASE index doing the blocking: insert directly, skipping our API.
  const existing = await getDb().collection('scores').findOne({});
  const duplicate = { ...existing };
  delete duplicate._id;
  await assert.rejects(getDb().collection('scores').insertOne(duplicate), (err) => err.code === 11000);
});

test('4. judge edits a score -> total and rank recalculated', async () => {
  // Team A = 7.9 (test 1). Give Team B 6.0, so Team A is rank 1.
  await api('POST', '/api/scores', {
    token: judge2Token,
    body: { teamId: teamB, criteria: { innovation: 6, design: 6, execution: 6 } },
  });
  await waitFor(async () => (await leaderboardRank(teamA)) === 1 && (await leaderboardRank(teamB)) === 2);

  // Judge 1 lowers Team A's marks to 2,2,2 -> total 2.0, so Team A should drop to rank 2.
  const res = await api('PUT', `/api/scores/${firstScoreId}`, {
    token: judgeToken,
    body: { criteria: { innovation: 2, design: 2, execution: 2 }, comment: 'Changed my mind' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);

  // The Change Stream notices the update and re-ranks automatically.
  await waitFor(async () => (await leaderboardRank(teamB)) === 1 && (await leaderboardRank(teamA)) === 2);
});

test('5. unauthorized user hits an admin route -> access denied', async () => {
  const noToken = await api('GET', '/api/events');
  assert.equal(noToken.status, 401);

  const judgeTriesAdmin = await api('GET', '/api/events', { token: judgeToken });
  assert.equal(judgeTriesAdmin.status, 403);

  const badToken = await api('GET', '/api/events', { token: 'not-a-real-token' });
  assert.equal(badToken.status, 401);
});

test('extra: team logs in with its code and sees its own rank', async () => {
  // Creating a team returns its access code once (only the hash is stored).
  const created = await api('POST', `/api/events/${eventId}/teams`, { token: adminToken, body: { name: 'Team C' } });
  assert.equal(created.status, 201);
  assert.match(created.body.code, /^[A-F0-9]{8}$/);

  const login = await api('POST', '/api/auth/team-login', { body: { code: created.body.code } });
  assert.equal(login.status, 200);

  // Team A has scores (tests 1 and 4), so log in as Team A via a fresh code.
  const reset = await api('POST', `/api/teams/${teamA}/reset-code`, { token: adminToken });
  const teamToken = (await api('POST', '/api/auth/team-login', { body: { code: reset.body.code } })).body.token;
  const me = await api('GET', '/api/team/me', { token: teamToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.team.name, 'Team A');
  assert.equal(me.body.standing.rank, 2);
  assert.equal(me.body.breakdown.length, 3);
  assert.equal(me.body.feedback, null); // hidden while the event is live

  // A team token must not open admin routes.
  const denied = await api('GET', '/api/events', { token: teamToken });
  assert.equal(denied.status, 403);
});

test('extra: demo accounts are limited to the demo event', async () => {
  const demoAdmin = (await api('POST', '/api/auth/demo-login', { body: { role: 'admin' } })).body.token;
  const demoJudge = (await api('POST', '/api/auth/demo-login', { body: { role: 'judge' } })).body.token;

  // The demo judge sees the 3 demo teams and can rate one of them.
  const me = await api('GET', '/api/judge/me', { token: demoJudge });
  assert.equal(me.body.teams.length, 3);
  assert.equal(me.body.event.demo, true);
  const rated = await api('POST', '/api/scores', {
    token: demoJudge,
    body: { teamId: me.body.teams[0]._id, criteria: { innovation: 10, design: 8, execution: 6 }, comment: 'Demo rating' },
  });
  assert.equal(rated.status, 201);

  // The demo admin only sees the demo event, and cannot touch the real test event.
  const list = await api('GET', '/api/events', { token: demoAdmin });
  assert.equal(list.body.length, 1);
  assert.equal((await api('GET', `/api/events/${eventId}`, { token: demoAdmin })).status, 403);
  assert.equal((await api('GET', `/api/events/${eventId}/teams`, { token: demoAdmin })).status, 403);
  assert.equal((await api('DELETE', `/api/events/${list.body[0]._id}`, { token: demoAdmin })).status, 403);
});

test('6. generate AI feedback for a team -> summary + sentiment saved (mock)', async () => {
  // Not allowed while the event is still live.
  const tooEarly = await api('POST', `/api/events/${eventId}/feedback/generate`, { token: adminToken });
  assert.equal(tooEarly.status, 409);

  await api('PATCH', `/api/events/${eventId}`, { token: adminToken, body: { status: 'closed' } });
  const res = await api('POST', `/api/events/${eventId}/feedback/generate`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.generated, 3); // Team A, Team B and Team C (added in the team test)

  // Check what was actually stored in MongoDB for Team A.
  const saved = await getDb().collection('feedback').findOne({ teamId: new ObjectId(teamA) });
  assert.ok(saved.summary.length > 0);
  assert.ok(['positive', 'neutral', 'negative'].includes(saved.sentiment.label));
  assert.equal(saved.source, 'mock');
});

test('extra: judge must give the right name with a chosen code', async () => {
  const created = await api('POST', `/api/events/${eventId}/judges`, { token: adminToken, body: { name: 'Prof Mehta', code: 'panel-07' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.code, 'PANEL-07');

  // Same code again -> refused by the unique codeHash index.
  const clash = await api('POST', `/api/events/${eventId}/judges`, { token: adminToken, body: { name: 'Someone', code: 'PANEL-07' } });
  assert.equal(clash.status, 409);

  assert.equal((await api('POST', '/api/auth/judge-login', { body: { name: 'Wrong Name', code: 'PANEL-07' } })).status, 401);
  const ok = await api('POST', '/api/auth/judge-login', { body: { name: 'prof mehta', code: 'panel-07' } });
  assert.equal(ok.status, 200);
  const me = await api('GET', '/api/judge/me', { token: ok.body.token });
  assert.equal(me.body.event.name, 'Test Event');
});

test('extra: registered admins only see and manage their own events', async () => {
  const reg = await api('POST', '/api/auth/admin-register', { body: { username: 'organiser1', password: 'longpassword' } });
  assert.equal(reg.status, 201);
  const dup = await api('POST', '/api/auth/admin-register', { body: { username: 'Organiser1', password: 'longpassword' } });
  assert.equal(dup.status, 409);
  assert.equal((await api('POST', '/api/auth/admin-login', { body: { username: 'organiser1', password: 'wrong-password' } })).status, 401);
  const token = (await api('POST', '/api/auth/admin-login', { body: { username: 'ORGANISER1', password: 'longpassword' } })).body.token;

  // New admin starts with no events and can't open someone else's.
  assert.equal((await api('GET', '/api/events', { token })).body.length, 0);
  assert.equal((await api('GET', `/api/events/${eventId}`, { token })).status, 403);
  assert.equal((await api('DELETE', `/api/events/${eventId}`, { token })).status, 403);

  const mine = await api('POST', '/api/events', {
    token,
    body: { name: 'My Event', rubric: [{ key: 'idea', label: 'Idea', max: 10, weight: 1 }] },
  });
  assert.equal(mine.status, 201);
  const list = (await api('GET', '/api/events', { token })).body;
  assert.deepEqual(list.map((e) => e.name), ['My Event']);

  // Bulk import (as sent by the Excel import): duplicates and bad rows are skipped.
  const imported = await api('POST', `/api/events/${mine.body._id}/teams/import`, {
    token,
    body: {
      teams: [
        { name: 'Alpha', members: ['A1', 'A2'] },
        { name: 'Beta', members: [], code: 'BETA-01' },
        { name: 'alpha', members: [] },
        { name: '', members: [] },
      ],
    },
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.imported, 2);
  assert.equal(imported.body.skipped.length, 2);
  assert.equal(imported.body.teams[1].code, 'BETA-01');
  assert.equal((await api('POST', '/api/auth/team-login', { body: { code: 'beta-01' } })).status, 200);
  assert.equal(await getDb().collection('teams').countDocuments({ eventId: new ObjectId(mine.body._id) }), 2);
});
