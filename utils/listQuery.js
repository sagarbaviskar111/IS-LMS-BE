// Small helpers shared by the admin lists (search / filter / sort).

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A case-insensitive "contains" matcher for a search box, or null if empty.
const searchRegex = (q) => {
  const t = String(q || "").trim().slice(0, 80);
  return t ? new RegExp(escapeRegex(t), "i") : null;
};

// Maps the ?sort= value to a Mongo sort, falling back to `fallback`.
const pickSort = (value, map, fallback) => map[value] || map[fallback];

// Names and emails should sort A-Z regardless of upper/lower case.
const CASE_INSENSITIVE = { locale: "en", strength: 2 };

module.exports = { escapeRegex, searchRegex, pickSort, CASE_INSENSITIVE };
