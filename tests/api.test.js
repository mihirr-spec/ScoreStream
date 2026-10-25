// API tests using Node's built-in test runner:  npm test
//
// They run against a SEPARATE database "<DB_NAME>_test" (dropped at the start and end),
// so your real data is never touched. They need the same Atlas cluster as the app
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
let teamAAccount;
let teamBAccount;

// Registers a team account, invites it to the test event by code and accepts.
// Returns { code, token } of the account.
async function joinEvent(name, members) {
  const reg = await api('POST', '/api/auth/team-register', { body: { name, members, password: 'team-password' } });
  const invite = await api('POST', `/api/events/${eventId}/invitations`, { token: adminToken, body: { code: reg.body.team.code } });
  await api('POST', `/api/team/invitations/${invite.body._id}`, { token: reg.body.token, body: { accept: true } });
  return { code: reg.body.team.code, token: reg.body.token };
}

// Registers a judge account, invites it to the test event by its judge code and accepts.
async function addJudge(name) {
  const reg = await api('POST', '/api/auth/judge-register', { body: { name, password: 'judge-password' } });
  const invite = await api('POST', `/api/events/${eventId}/judges`, { token: adminToken, body: { code: reg.body.judge.code } });
  await api('POST', `/api/judge/invitations/${invite.body._id}`, { token: reg.body.token, body: { accept: true } });
  return { code: reg.body.judge.code, token: reg.body.token };
}

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

  // Teams register their own accounts, get invited by code, and accept.
  teamAAccount = await joinEvent('Team A', ['Ann']);
  teamBAccount = await joinEvent('Team B', ['Ben']);
  const teams = (await api('GET', `/api/events/${eventId}/teams`, { token: adminToken })).body;
  teamA = teams.find((t) => t.name === 'Team A')._id;
  teamB = teams.find((t) => t.name === 'Team B')._id;

  // Judges also register their own accounts, get invited by judge code, and accept.
  judgeToken = (await addJudge('Judge 1')).token;
  judge2Token = (await addJudge('Judge 2')).token;
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

test('extra: team signs in with code + password and sees its rank in the event', async () => {
  assert.equal((await api('POST', '/api/auth/team-login', { body: { code: teamAAccount.code, password: 'wrong-password' } })).status, 401);
  const login = await api('POST', '/api/auth/team-login', { body: { code: teamAAccount.code.toLowerCase(), password: 'team-password' } });
  assert.equal(login.status, 200);
  const token = login.body.token;

  const me = await api('GET', '/api/team/me', { token });
  assert.equal(me.body.team.name, 'Team A');
  assert.match(me.body.team.code, /^TM[A-Z0-9]{6}$/);
  assert.equal(me.body.events.length, 1);
  assert.equal(me.body.events[0].rank, 2);

  const detail = await api('GET', `/api/team/events/${eventId}`, { token });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.standing.rank, 2);
  assert.equal(detail.body.breakdown.length, 3);
  assert.equal(detail.body.judgeScores.length, 1);
  assert.equal(detail.body.feedback, null); // hidden while the event is live

  // A team token must not open admin routes.
  assert.equal((await api('GET', '/api/events', { token })).status, 403);
});

test('extra: a team joins only after accepting, and duplicates are refused', async () => {
  const reg = await api('POST', '/api/auth/team-register', { body: { name: 'Team C', members: ['Cy'], password: 'team-password' } });
  const code = reg.body.team.code;

  // Unknown code, and a team that is already in the event.
  assert.equal((await api('POST', `/api/events/${eventId}/invitations`, { token: adminToken, body: { code: 'TMZZZZZZ' } })).status, 404);
  assert.equal((await api('POST', `/api/events/${eventId}/invitations`, { token: adminToken, body: { code: teamAAccount.code } })).status, 409);

  // Inviting does NOT add the team yet, and a second invite is refused.
  const invite = await api('POST', `/api/events/${eventId}/invitations`, { token: adminToken, body: { code } });
  assert.equal(invite.status, 201);
  assert.equal((await api('POST', `/api/events/${eventId}/invitations`, { token: adminToken, body: { code } })).status, 409);
  assert.equal((await api('GET', `/api/events/${eventId}/teams`, { token: adminToken })).body.length, 2);

  // The team sees the invitation with the admin's name, and accepts it.
  const me = await api('GET', '/api/team/me', { token: reg.body.token });
  assert.equal(me.body.invitations.length, 1);
  assert.equal(me.body.invitations[0].eventName, 'Test Event');
  assert.equal(me.body.invitations[0].invitedBy, config.adminUsername);
  const accepted = await api('POST', `/api/team/invitations/${invite.body._id}`, { token: reg.body.token, body: { accept: true } });
  assert.equal(accepted.status, 200);
  assert.equal((await api('GET', `/api/events/${eventId}/teams`, { token: adminToken })).body.length, 3);
  // Answering twice is refused.
  assert.equal((await api('POST', `/api/team/invitations/${invite.body._id}`, { token: reg.body.token, body: { accept: false } })).status, 409);

  // Excel-style bulk invite: a declined team never joins.
  const regD = await api('POST', '/api/auth/team-register', { body: { name: 'Team D', members: [], password: 'team-password' } });
  const bulk = await api('POST', `/api/events/${eventId}/invitations`, {
    token: adminToken,
    body: { codes: [regD.body.team.code, code, regD.body.team.code, 'nope'] },
  });
  assert.equal(bulk.body.invited.length, 1);
  assert.equal(bulk.body.skipped.length, 3);
  const inviteD = (await api('GET', '/api/team/me', { token: regD.body.token })).body.invitations[0];
  await api('POST', `/api/team/invitations/${inviteD._id}`, { token: regD.body.token, body: { accept: false } });
  assert.equal((await api('GET', `/api/events/${eventId}/teams`, { token: adminToken })).body.length, 3);

  // The database itself refuses a second copy of a team in the same event.
  const existing = await getDb().collection('teams').findOne({ name: 'Team C' });
  const copy = { ...existing };
  delete copy._id;
  await assert.rejects(getDb().collection('teams').insertOne(copy), (err) => err.code === 11000);
});

test('extra: a team shares its repo and slides, and its judges can open them', async () => {
  const token = teamAAccount.token;
  const bad = await api('PUT', `/api/team/events/${eventId}/submission`, { token, body: { githubUrl: 'https://example.com/x' } });
  assert.equal(bad.status, 400);
  const saved = await api('PUT', `/api/team/events/${eventId}/submission`, { token, body: { githubUrl: 'https://github.com/team-a/project' } });
  assert.equal(saved.status, 200);

  // Upload: the raw file is the request body; it is stored in GridFS.
  const bytes = Buffer.from('PK fake pptx bytes '.repeat(500));
  const upload = (name, body) =>
    fetch(`${baseUrl}/api/team/events/${eventId}/slides?name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body,
    });
  assert.equal((await upload('notes.txt', bytes)).status, 400);
  const ok = await upload('Team A deck.pptx', bytes);
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).slides.size, bytes.length);
  assert.equal(await getDb().collection('slides.files').countDocuments({}), 1);

  // Replacing the slides deletes the old file.
  assert.equal((await upload('Team A deck v2.pptx', bytes)).status, 201);
  assert.equal(await getDb().collection('slides.files').countDocuments({}), 1);

  // The judge sees the link and file name, and downloads the exact bytes.
  const me = await api('GET', `/api/judge/events/${eventId}`, { token: judgeToken });
  const teamRow = me.body.teams.find((t) => t._id === teamA);
  assert.equal(teamRow.githubUrl, 'https://github.com/team-a/project');
  assert.equal(teamRow.slides.filename, 'Team A deck v2.pptx');
  const download = await fetch(`${baseUrl}/api/judge/teams/${teamA}/slides`, { headers: { Authorization: `Bearer ${judgeToken}` } });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

  // The admin can open it too, and the team's results page shows the submission.
  const adminDownload = await fetch(`${baseUrl}/api/teams/${teamA}/slides`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(adminDownload.status, 200);
  const detail = await api('GET', `/api/team/events/${eventId}`, { token });
  assert.equal(detail.body.submission.slides.filename, 'Team A deck v2.pptx');
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

test('extra: after the event ends judges can look back but not score', async () => {
  // Test 6 closed the event. The judge still sees it, but scoring is refused.
  const me = await api('GET', '/api/judge/me', { token: judgeToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.events.find((e) => e.eventId === eventId).status, 'closed');
  const late = await api('POST', '/api/scores', {
    token: judgeToken,
    body: { teamId: teamB, criteria: { innovation: 5, design: 5, execution: 5 } },
  });
  assert.ok([403, 409].includes(late.status));
});

test('extra: submissions are locked once the event has ended', async () => {
  const res = await api('PUT', `/api/team/events/${eventId}/submission`, { token: teamAAccount.token, body: { githubUrl: 'https://github.com/team-a/other' } });
  assert.equal(res.status, 409);
});

test('extra: judges join an event only by accepting an invitation', async () => {
  const otherEvent = await api('POST', '/api/events', {
    token: adminToken,
    body: { name: 'Second Event', status: 'live', rubric: [{ key: 'idea', label: 'Idea', max: 10, weight: 1 }] },
  });
  const otherId = otherEvent.body._id;
  const reg = await api('POST', '/api/auth/judge-register', { body: { name: 'Prof Mehta', password: 'judge-password' } });
  assert.equal(reg.status, 201);
  assert.match(reg.body.judge.code, /^JG[A-Z0-9]{6}$/);
  const token = reg.body.token;

  // Login is judge code + password.
  assert.equal((await api('POST', '/api/auth/judge-login', { body: { code: reg.body.judge.code, password: 'nope-nope' } })).status, 401);
  assert.equal((await api('POST', '/api/auth/judge-login', { body: { code: reg.body.judge.code.toLowerCase(), password: 'judge-password' } })).status, 200);

  // Unknown code -> 404. Invite -> pending, and inviting again is a duplicate.
  assert.equal((await api('POST', `/api/events/${otherId}/judges`, { token: adminToken, body: { code: 'JG000000' } })).status, 404);
  const invite = await api('POST', `/api/events/${otherId}/judges`, { token: adminToken, body: { code: reg.body.judge.code } });
  assert.equal(invite.status, 201);
  assert.equal((await api('POST', `/api/events/${otherId}/judges`, { token: adminToken, body: { code: reg.body.judge.code } })).status, 409);
  assert.equal((await api('GET', `/api/events/${otherId}/judge-invitations`, { token: adminToken })).body.length, 1);

  // Before accepting, the judge is not in the event and can't open it.
  const before = await api('GET', '/api/judge/me', { token });
  assert.equal(before.body.events.length, 0);
  assert.equal(before.body.invitations[0].eventName, 'Second Event');
  assert.equal((await api('GET', `/api/judge/events/${otherId}`, { token })).status, 403);

  // Accept -> they are a judge in the event; answering twice is refused.
  assert.equal((await api('POST', `/api/judge/invitations/${invite.body._id}`, { token, body: { accept: true } })).status, 200);
  assert.equal((await api('POST', `/api/judge/invitations/${invite.body._id}`, { token, body: { accept: false } })).status, 409);
  const after = await api('GET', '/api/judge/me', { token });
  assert.deepEqual(after.body.events.map((e) => e.name), ['Second Event']);
  const judges = (await api('GET', `/api/events/${otherId}/judges`, { token: adminToken })).body;
  assert.equal(judges[0].code, reg.body.judge.code);

  // Already a judge -> inviting again is refused. They can't score a team of another event.
  assert.equal((await api('POST', `/api/events/${otherId}/judges`, { token: adminToken, body: { code: reg.body.judge.code } })).status, 409);
  const wrongEvent = await api('POST', '/api/scores', { token, body: { teamId: teamA, criteria: { innovation: 5, design: 5, execution: 5 } } });
  assert.equal(wrongEvent.status, 403);
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

  // Another admin's event can't be used to invite teams either.
  assert.equal((await api('POST', `/api/events/${eventId}/invitations`, { token, body: { code: teamAAccount.code } })).status, 403);
});
