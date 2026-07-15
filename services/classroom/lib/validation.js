// Shared request validation helpers (same shape as the analytics service).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Accepts an ISO-8601 string, returns a Date or null (invalid/absent).
function parseDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function nonEmptyString(value, max = 10000) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

module.exports = { isUuid, parseDate, nonEmptyString };
