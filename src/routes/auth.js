// Login routes: admin logs in with a password, judges and teams with an access code,
// and anyone can open a one-click demo account.

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { getDb } = require('../db');
const { signToken, sha256 } = require('../middleware/auth');
const { ensureDemoEvent } = require('../services/demo');
const { httpError, isNonEmptyString } = require('../middleware/validate');

const router = express.Router();

// POST /api/auth/admin-login  { password }
router.post('/auth/admin-login', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length === 0) {
    throw httpError(400, 'password is required');
  }

  // timingSafeEqual compares in constant time, so an attacker can't guess the
  // password letter-by-letter by measuring how fast a wrong answer is rejected.
  // It needs two buffers of the SAME length, so we compare SHA-256 hashes
  // (always 32 bytes) instead of the raw strings.
  const given = crypto.createHash('sha256').update(password).digest();
  const expected = crypto.createHash('sha256').update(config.adminPassword).digest();
  if (!crypto.timingSafeEqual(given, expected)) {
    throw httpError(401, 'Wrong password');
  }

  res.json({ token: signToken({ role: 'admin' }) });
});

// POST /api/auth/judge-login  { code }
router.post('/auth/judge-login', async (req, res) => {
  const { code } = req.body || {};
  if (!isNonEmptyString(code, 50)) {
    throw httpError(400, 'code is required');
  }

  // We only ever stored the HASH of the code, so hash what the judge typed
  // and look for a match (uses the unique codeHash index).
  const db = getDb();
  const judge = await db.collection('judges').findOne({ codeHash: sha256(code.trim().toUpperCase()) });
  if (!judge) {
    throw httpError(401, 'Invalid judge code');
  }

  const event = await db.collection('events').findOne({ _id: judge.eventId });
  if (!event) {
    throw httpError(401, 'This judge\'s event no longer exists');
  }

  const token = signToken({
    role: 'judge',
    judgeId: judge._id.toString(),
    eventId: judge.eventId.toString(),
  });
  res.json({ token, judge: { name: judge.name }, event: { _id: event._id, name: event.name } });
});

// POST /api/auth/team-login  { code }
// Works exactly like judge login, but looks in the teams collection.
router.post('/auth/team-login', async (req, res) => {
  const { code } = req.body || {};
  if (!isNonEmptyString(code, 50)) {
    throw httpError(400, 'code is required');
  }

  const db = getDb();
  const team = await db.collection('teams').findOne({ codeHash: sha256(code.trim().toUpperCase()) });
  if (!team) {
    throw httpError(401, 'Invalid team code');
  }

  const event = await db.collection('events').findOne({ _id: team.eventId });
  if (!event) {
    throw httpError(401, 'This team\'s event no longer exists');
  }

  const token = signToken({ role: 'team', teamId: team._id.toString(), eventId: team.eventId.toString() });
  res.json({ token, team: { name: team.name }, event: { _id: event._id, name: event.name } });
});

// POST /api/auth/demo-login  { role: 'admin' | 'judge' | 'team' }
// One-click demo accounts. No password needed, because every demo account is
// limited to the shared demo event (created in MongoDB on first use).
router.post('/auth/demo-login', async (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'judge', 'team'].includes(role)) {
    throw httpError(400, 'role must be admin, judge or team');
  }

  const db = getDb();
  const event = await ensureDemoEvent();
  const eventId = event._id.toString();

  if (role === 'admin') {
    // demoEventId locks this admin token to the demo event (see requireAdmin).
    return res.json({ token: signToken({ role: 'admin', demoEventId: eventId }), demo: true, event: { _id: event._id, name: event.name } });
  }

  if (role === 'judge') {
    const judge = await db.collection('judges').findOne({ eventId: event._id, name: 'Demo Judge' });
    if (!judge) throw httpError(404, 'The demo judge was removed. Ask the admin to reset the demo.');
    return res.json({
      token: signToken({ role: 'judge', judgeId: judge._id.toString(), eventId }),
      demo: true,
      judge: { name: judge.name },
      event: { _id: event._id, name: event.name },
    });
  }

  // role === 'team': the first demo team alphabetically (Team Nova).
  const team = await db.collection('teams').find({ eventId: event._id }).sort({ name: 1 }).limit(1).next();
  if (!team) throw httpError(404, 'The demo teams were removed. Ask the admin to reset the demo.');
  return res.json({
    token: signToken({ role: 'team', teamId: team._id.toString(), eventId }),
    demo: true,
    team: { name: team.name },
    event: { _id: event._id, name: event.name },
  });
});

module.exports = router;
