// Login routes: admin logs in with a password, judges with their access code.

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { getDb } = require('../db');
const { signToken, sha256 } = require('../middleware/auth');
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

module.exports = router;
