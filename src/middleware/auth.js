// Login tokens and the checks that protect admin and judge routes.
//
// A token is a JWT: a small signed string like "xxxxx.yyyyy.zzzzz" holding
// { role, ... }. It is signed with JWT_SECRET, so the browser can READ it but
// cannot CHANGE it (a changed token fails verification).
// The browser sends it back in the header:  Authorization: Bearer <token>

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db');
const { httpError, parseId } = require('./validate');

// SHA-256 as 64 hex characters. Judge access codes are stored ONLY as this hash,
// so even someone who reads the database can't see the real codes.
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '12h' });
}

// Reads and verifies the token. Throws 401 if it is missing or invalid.
function readToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    throw httpError(401, 'Please log in first');
  }
  try {
    return jwt.verify(header.slice('Bearer '.length), config.jwtSecret);
  } catch {
    throw httpError(401, 'Your login has expired or is invalid. Please log in again');
  }
}

// 401 = "we don't know who you are", 403 = "we know who you are, but you're not allowed".
function requireAdmin(req, res, next) {
  const payload = readToken(req);
  if (payload.role !== 'admin') {
    throw httpError(403, 'Admin access only');
  }
  next();
}

// Judges: besides checking the token, make sure the judge still exists
// (the admin may have deleted them after they logged in).
async function requireJudge(req, res, next) {
  const payload = readToken(req);
  if (payload.role !== 'judge') {
    throw httpError(403, 'Judge access only');
  }
  const judge = await getDb()
    .collection('judges')
    .findOne({ _id: parseId(payload.judgeId, 'judge id') });
  if (!judge) {
    throw httpError(401, 'This judge account no longer exists');
  }
  // Later handlers use req.judge (its eventId decides which event they may score).
  req.judge = judge;
  next();
}

module.exports = { sha256, signToken, requireAdmin, requireJudge };
