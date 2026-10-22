// Parses a date-range boundary from a query string.
//  - A full ISO timestamp (what the app sends: the viewer's own local
//    start/end of day, so "today" means today where they are) is used as-is.
//  - A bare YYYY-MM-DD is read as a UTC day, start or end.
// Returns null for anything unparseable.
const parseBoundary = (value, endOfDay) => {
  if (!value) return null;
  const s = String(value).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`) : new Date(s);
  return isNaN(d) ? null : d;
};

// { $gte, $lte } for ?from= / ?to=, or null when neither is given.
const dateRange = (query) => {
  const range = {};
  const from = parseBoundary(query.from, false);
  const to = parseBoundary(query.to, true);
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return Object.keys(range).length ? range : null;
};

module.exports = { dateRange };
