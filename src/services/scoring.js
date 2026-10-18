// Scoring rules: check a judge's marks against the event rubric, and work out the total.

const { isNumber } = require('../middleware/validate');

// criteria looks like { idea: 8, design: 7, execution: 9 }.
// Returns an error message, or null if everything is valid.
function validateCriteria(rubric, criteria) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
    return 'criteria must be an object like { "idea": 8 }';
  }

  const rubricKeys = rubric.map((item) => item.key);

  // 1. Reject keys that are not in this event's rubric.
  for (const key of Object.keys(criteria)) {
    if (!rubricKeys.includes(key)) {
      return `Unknown criterion "${key}". Allowed: ${rubricKeys.join(', ')}`;
    }
  }

  // 2. Every rubric criterion must have a mark between 0 and its max.
  for (const item of rubric) {
    const mark = criteria[item.key];
    if (mark === undefined) {
      return `Missing mark for "${item.label}"`;
    }
    if (!isNumber(mark)) {
      return `Mark for "${item.label}" must be a number`;
    }
    if (mark < 0 || mark > item.max) {
      return `Mark for "${item.label}" must be between 0 and ${item.max}`;
    }
  }
  return null;
}

// total = 10 * sum( (mark / max) * weight )  -> always out of 10.
// Example: marks 8,7,9 (max 10), weights 0.3,0.4,0.3 -> 10 * (0.24 + 0.28 + 0.27) = 7.9
function calculateTotal(rubric, criteria) {
  let sum = 0;
  for (const item of rubric) {
    sum += (criteria[item.key] / item.max) * item.weight;
  }
  // Round to 2 decimal places so 7.8999999 shows as 7.9.
  return Math.round(sum * 10 * 100) / 100;
}

module.exports = { validateCriteria, calculateTotal };
