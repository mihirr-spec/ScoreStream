// Login routes: admins, judges and teams register and log in with a password.
// Judges and teams use their permanent account code as the "username".

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { getDb } = require('../db');
const { signToken, hashPassword, checkPassword, generateTeamCode, generateJudgeCode } = require('../middleware/auth');
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

// Inserts a new account with a fresh random code. The unique code index makes a clash
// impossible; on the (very rare) clash, try again with a new code.
async function insertWithCode(collection, account, makeCode) {
  for (let attempt = 1; ; attempt++) {
    account.code = makeCode();
    try {
      const result = await collection.insertOne(account);
      return result.insertedId;
    } catch (err) {
      if (err.code !== 11000 || attempt >= 5) throw err;
      delete account._id;
    }
  }
}

function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw httpError(400, 'password must be at least 8 characters');
  }
}

// POST /api/auth/judge-register  { name, password }
// A judge creates their own account and gets a permanent judge code. An organiser
// enters that code to INVITE them to an event; the judge then accepts or declines.
router.post('/auth/judge-register', async (req, res) => {
  const { name, password } = req.body || {};
  if (!isNonEmptyString(name, 100)) throw httpError(400, 'your name is required (max 100 characters)');
  checkNewPassword(password);

  const account = { name: name.trim(), passwordHash: hashPassword(password), createdAt: new Date() };
  const id = await insertWithCode(getDb().collection('judgeAccounts'), account, generateJudgeCode);
  const token = signToken({ role: 'judge', accountId: id.toString() });
  res.status(201).json({ token, judge: { _id: id, name: account.name, code: account.code } });
});

// POST /api/auth/judge-login  { code, password }
router.post('/auth/judge-login', async (req, res) => {
  const { code, password } = req.body || {};
  if (!isNonEmptyString(code, 50)) throw httpError(400, 'judge code is required');
  if (typeof password !== 'string' || password.length === 0) throw httpError(400, 'password is required');

  const account = await getDb().collection('judgeAccounts').findOne({ code: code.trim().toUpperCase() });
  // Same message for an unknown code or a wrong password.
  if (!account || !checkPassword(password, account.passwordHash)) {
    throw httpError(401, 'Wrong judge code or password');
  }
  const token = signToken({ role: 'judge', accountId: account._id.toString() });
  res.json({ token, judge: { _id: account._id, name: account.name, code: account.code } });
});

// POST /api/auth/team-register  { name, members, password }
// A team creates its own account and gets a permanent team code. Admins use that
// code to INVITE the team to an event; the team then accepts or declines.
router.post('/auth/team-register', async (req, res) => {
  const { name, members, password } = req.body || {};
  if (!isNonEmptyString(name, 100)) throw httpError(400, 'team name is required (max 100 characters)');
  const cleanedMembers = cleanMembers(members);
  if (cleanedMembers === null) throw httpError(400, 'members must be a list of up to 20 names');
  checkNewPassword(password);

  const account = {
    name: name.trim(),
    members: cleanedMembers,
    passwordHash: hashPassword(password),
    createdAt: new Date(),
  };
  const id = await insertWithCode(getDb().collection('teamAccounts'), account, generateTeamCode);
  const token = signToken({ role: 'team', accountId: id.toString() });
  res.status(201).json({ token, team: { _id: id, name: account.name, code: account.code } });
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
