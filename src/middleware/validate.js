// Small input-validation helpers shared by all routes.
// Rule: NEVER trust the browser. Every value is checked here on the server.

const { ObjectId } = require('mongodb');

// Creates an error that the central error handler (server.js) turns into
// { error: message } with the given HTTP status. expose=true means
// "this message is safe to show to the client".
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

// Turns a string from the URL/body into a MongoDB ObjectId.
// A valid id is exactly 24 hex characters. Anything else -> 400 Bad Request
// (instead of crashing the driver or matching nothing).
function parseId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) {
    throw httpError(400, `Invalid ${label}`);
  }
  return new ObjectId(value);
}

function isNonEmptyString(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

// A "real" number: not NaN, not Infinity, not a string like "8".
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Checks a rubric like [{ key: 'idea', label: 'Idea', max: 10, weight: 0.3 }, ...].
// Returns an error message string, or null if the rubric is fine.
function validateRubric(rubric) {
  if (!Array.isArray(rubric) || rubric.length === 0) {
    return 'rubric must be a non-empty array';
  }
  const seenKeys = new Set();
  let weightSum = 0;

  for (const item of rubric) {
    if (!item || typeof item !== 'object') return 'each rubric item must be an object';
    // Keys become field names inside score.criteria, so only allow safe characters
    // (a "$" or "." in a field name has special meaning in MongoDB).
    if (typeof item.key !== 'string' || !/^[a-zA-Z0-9_]{1,30}$/.test(item.key)) {
      return 'rubric key must be 1-30 letters, digits or _';
    }
    if (seenKeys.has(item.key)) return `duplicate rubric key "${item.key}"`;
    seenKeys.add(item.key);
    if (!isNonEmptyString(item.label, 60)) return `rubric "${item.key}" needs a label`;
    if (!isNumber(item.max) || item.max < 1) return `rubric "${item.key}" max must be a number >= 1`;
    if (!isNumber(item.weight) || item.weight < 0 || item.weight > 1) {
      return `rubric "${item.key}" weight must be between 0 and 1`;
    }
    weightSum += item.weight;
  }

  // $jsonSchema cannot check a SUM across array items, so this rule lives here.
  // Small tolerance because 0.1 + 0.2 is 0.30000000000000004 in JavaScript.
  if (Math.abs(weightSum - 1) > 0.001) {
    return `rubric weights must add up to 1 (they add up to ${weightSum.toFixed(3)})`;
  }
  return null;
}

// Keep only the fields we want, trimmed (so extra junk in the request is ignored).
function cleanRubric(rubric) {
  return rubric.map((item) => ({
    key: item.key,
    label: item.label.trim(),
    max: item.max,
    weight: item.weight,
  }));
}

// members must be an array of names. Returns a cleaned array or null if invalid.
function cleanMembers(members) {
  if (members === undefined) return [];
  if (!Array.isArray(members) || members.length > 20) return null;
  if (!members.every((m) => isNonEmptyString(m, 80))) return null;
  return members.map((m) => m.trim());
}

const EVENT_STATUSES = ['draft', 'live', 'closed'];

module.exports = {
  httpError,
  parseId,
  isNonEmptyString,
  isNumber,
  validateRubric,
  cleanRubric,
  cleanMembers,
  EVENT_STATUSES,
};
