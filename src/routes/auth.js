// Login routes: admins and teams register and log in with a password (teams use their
// permanent team code as the "username"), judges with their name + access code.

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { getDb } = require('../db');
const { signToken, sha256, hashPassword, checkPassword, generateTeamCode } = require('../middleware/auth');
const { httpError, isNonEmptyString, isValidUsername, cleanMembers } = require('../middleware/validate');

const router = express.Router();

// timingSafeEqual compares in constant time, so an attacker can't guess the
// value letter-by-letter by measuring how fast a wrong answer is rejected.
// It needs two buffers of the SAME length, so we compare SHA-256 hashes
// (always 32 bytes) instead of the raw strings.
function safeEqual(given, expected) {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// POST /api/auth/admin-register  { username, password }
// Anyone can create an organiser account. Each admin only sees the events they create.
router.post('/auth/admin-register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!isValidUsername(username)) {
    throw httpError(400, 'username must be 3-30 letters, digits, dot, dash or underscore');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw httpError(400, 'password must be at least 8 characters');
  }
  const name = username.trim();
  // The .env admin's name is reserved, so nobody can register a look-alike account.
  if (name.toLowerCase() === config.adminUsername.toLowerCase()) {
    throw httpError(409, 'That username is already taken');
  }

  const admin = {
    username: name,
    usernameLower: name.toLowerCase(), // the unique index is on this, so "Asha" and "asha" clash
    passwordHash: hashPassword(password),
    createdAt: new Date(),
  };
  let result;
  try {
    result = await getDb().collection('admins').insertOne(admin);
  } catch (err) {
    if (err.code === 11000) throw httpError(409, 'That username is already taken');
    throw err;
  }

  const token = signToken({ role: 'admin', adminId: result.insertedId.toString(), username: name });
  res.status(201).json({ token, admin: { _id: result.insertedId, username: name } });
});

// POST /api/auth/admin-login  { username, password }
// Registered admins are looked up in MongoDB. The admin from .env (ADMIN_USERNAME /
// ADMIN_PASSWORD) also still works, and can see every event.
router.post('/auth/admin-login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!isNonEmptyString(username, 100)) {
    throw httpError(400, 'username is required');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw httpError(400, 'password is required');
  }

  const admin = await getDb().collection('admins').findOne({ usernameLower: username.trim().toLowerCase() });
  if (admin) {
    if (!checkPassword(password, admin.passwordHash)) {
      throw httpError(401, 'Wrong username or password');
    }
    const token = signToken({ role: 'admin', adminId: admin._id.toString(), username: admin.username });
    return res.json({ token, admin: { _id: admin._id, username: admin.username } });
  }

  // Check BOTH, and give the same message either way, so nobody can find out
  // which of the two was wrong. (& not &&: always run both comparisons.)
  const usernameOk = safeEqual(username.trim(), config.adminUsername);
  const passwordOk = safeEqual(password, config.adminPassword);
  if (!(usernameOk & passwordOk)) {
    throw httpError(401, 'Wrong username or password');
  }

  res.json({ token: signToken({ role: 'admin', username: config.adminUsername }) });
});

// POST /api/auth/judge-login  { name, code }
// The judge types the name the admin gave them AND their access code.
router.post('/auth/judge-login', async (req, res) => {
  const { name, code } = req.body || {};
  if (!isNonEmptyString(name, 100)) {
    throw httpError(400, 'name is required');
  }
  if (!isNonEmptyString(code, 50)) {
    throw httpError(400, 'code is required');
  }

  // We only ever stored the HASH of the code, so hash what the judge typed
  // and look for a match (uses the unique codeHash index), then check the name too.
  // Same message for a wrong name or a wrong code, so neither can be guessed alone.
  const db = getDb();
  const judge = await db.collection('judges').findOne({ codeHash: sha256(code.trim().toUpperCase()) });
  if (!judge || judge.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
    throw httpError(401, 'Wrong judge name or code');
  }
  if (judge.expiredAt) {
    throw httpError(401, 'This event has ended, so this judge code has expired');
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

// POST /api/auth/team-register  { name, members, password }
// A team creates its own account and gets a permanent team code. Admins use that
// code to INVITE the team to an event; the team then accepts or declines.
router.post('/auth/team-register', async (req, res) => {
  const { name, members, password } = req.body || {};
  if (!isNonEmptyString(name, 100)) throw httpError(400, 'team name is required (max 100 characters)');
  const cleanedMembers = cleanMembers(members);
  if (cleanedMembers === null) throw httpError(400, 'members must be a list of up to 20 names');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw httpError(400, 'password must be at least 8 characters');
  }

  const account = {
    name: name.trim(),
    members: cleanedMembers,
    code: generateTeamCode(),
    passwordHash: hashPassword(password),
    createdAt: new Date(),
  };
  const accounts = getDb().collection('teamAccounts');
  // The unique code index makes a clash impossible; on the (very rare) clash, try a new code.
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await accounts.insertOne(account);
      const token = signToken({ role: 'team', accountId: result.insertedId.toString() });
      return res.status(201).json({ token, team: { _id: result.insertedId, name: account.name, code: account.code } });
    } catch (err) {
      if (err.code !== 11000 || attempt >= 5) throw err;
      account.code = generateTeamCode();
      delete account._id;
    }
  }
});

// POST /api/auth/team-login  { code, password }
router.post('/auth/team-login', async (req, res) => {
  const { code, password } = req.body || {};
  if (!isNonEmptyString(code, 50)) throw httpError(400, 'team code is required');
  if (typeof password !== 'string' || password.length === 0) throw httpError(400, 'password is required');

  const account = await getDb().collection('teamAccounts').findOne({ code: code.trim().toUpperCase() });
  // Same message for an unknown code or a wrong password.
  if (!account || !checkPassword(password, account.passwordHash)) {
    throw httpError(401, 'Wrong team code or password');
  }
  const token = signToken({ role: 'team', accountId: account._id.toString() });
  res.json({ token, team: { _id: account._id, name: account.name, code: account.code } });
});

module.exports = router;
