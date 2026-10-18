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
  // A demo admin token carries demoEventId: it may only touch that one event.
  // A real admin (logged in with the password) has no demoEventId -> full access.
  req.demoEventId = payload.demoEventId || null;
  next();
}

// Called by admin routes once they know which event a request is about.
function assertEventAccess(req, eventId) {
  if (req.demoEventId && req.demoEventId !== eventId.toString()) {
    throw httpError(403, 'The demo admin can only manage the demo event');
  }
}

// For actions a demo admin must never do (create or delete whole events).
function denyDemo(req, action) {
  if (req.demoEventId) {
    throw httpError(403, `The demo admin cannot ${action}`);
  }
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

// Teams: same idea as judges. A team can only see its own results.
async function requireTeam(req, res, next) {
  const payload = readToken(req);
  if (payload.role !== 'team') {
    throw httpError(403, 'Team access only');
  }
  const team = await getDb()
    .collection('teams')
    .findOne({ _id: parseId(payload.teamId, 'team id') });
  if (!team) {
    throw httpError(401, 'This team no longer exists');
  }
  req.team = team;
  next();
}

// Random 8-character access code, e.g. "4F9A1C2B" (used for judges and teams).
// crypto.randomBytes is cryptographically random, unlike Math.random().
function generateCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

module.exports = {
  sha256,
  signToken,
  requireAdmin,
  assertEventAccess,
  denyDemo,
  requireJudge,
  requireTeam,
  generateCode,
};
