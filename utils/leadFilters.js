const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const { dateRange } = require("./dateRange");
const { normalizePhone, normalizeEmail } = require("./validators");

const STATUSES = ["new", "contacted", "no_answer", "call_back_later", "interested", "not_interested", "wrong_number", "converted", "lost"];
const SOURCES = ["manual", "webhook", "inquiry_form", "import"];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Turns the lead-list query string into a Mongo filter on top of `base` (the
// part that scopes the list: this admin's leads, or this caller's leads).
//   q          name / phone / email contains
//   status     one of STATUSES
//   telecaller "unassigned" or a user id        (only when allowTelecaller)
//   source     manual | webhook | inquiry_form
//   sourceLabel exact label (the form's subject / the integration's name)
//   calls      "none" (never called) | "some" (called at least once)
//   from / to  created-at date range (inclusive)
const buildLeadFilter = (query, base, { allowTelecaller = false } = {}) => {
  const filter = { ...base };

  const q = (query.q || "").toString().trim().slice(0, 100);
  if (q) {
    const or = [{ name: new RegExp(escapeRegex(q), "i") }, { email: new RegExp(escapeRegex(q), "i") }];
    // Phones are stored without spaces/dashes, so match a typed "98765 43210" too.
    or.push({ phone: new RegExp(escapeRegex(q.replace(/[\s\-()]/g, "")), "i") });
    filter.$or = or;
  }

  if (STATUSES.includes(query.status)) filter.status = query.status;

  if (allowTelecaller && query.telecaller) {
    if (query.telecaller === "unassigned") filter.assignedTelecaller = null;
    else if (mongoose.Types.ObjectId.isValid(query.telecaller)) filter.assignedTelecaller = query.telecaller;
  }

  if (SOURCES.includes(query.source)) {
    // Leads from before `source` existed have no value and count as manual.
    filter.source = query.source === "manual" ? { $nin: ["webhook", "inquiry_form", "import"] } : query.source;
  }
  if (query.sourceLabel) filter.sourceLabel = query.sourceLabel.toString().slice(0, 100);

  if (query.calls === "none") filter["callLogs.0"] = { $exists: false };
  else if (query.calls === "some") filter["callLogs.0"] = { $exists: true };

  // Follow-up reminders: overdue / due today (client sends its own day bounds
  // so "today" is the caller's day) / any later one / has one at all.
  const parseDate = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  if (query.followUp) {
    const now = new Date();
    const dayStart = parseDate(query.dayStart) || new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = parseDate(query.dayEnd) || new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
    if (query.followUp === "overdue") filter.followUpAt = { $lt: now };
    else if (query.followUp === "today") filter.followUpAt = { $gte: dayStart, $lte: dayEnd };
    else if (query.followUp === "upcoming") filter.followUpAt = { $gt: dayEnd };
    else if (query.followUp === "any") filter.followUpAt = { $ne: null };
    // Open leads only — a converted/closed lead's reminder no longer matters.
    if (filter.followUpAt) filter.status = filter.status || { $nin: ["converted", "lost", "not_interested", "wrong_number"] };
  }

  const range = dateRange(query);
  if (range) filter.createdAt = range;

  return filter;
};

const buildLeadSort = (query) => {
  if (query.followUp) return { followUpAt: 1 };
  if (query.sort === "oldest") return { createdAt: 1 };
  if (query.sort === "name") return { name: 1 };
  return { createdAt: -1 };
};

// Distinct sources among `base` leads, for the Source filter dropdown.
const leadSources = async (base) => {
  const rows = await Lead.aggregate([
    { $match: base },
    { $group: { _id: { source: { $ifNull: ["$source", "manual"] }, label: "$sourceLabel" }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  return rows.map((r) => ({ source: r._id.source, label: r._id.label || null, count: r.count }));
};

// A lead is "invalid" when its phone isn't a usable mobile number, or it has an
// email that isn't a real address (a blank email is fine — it's optional).
const isInvalidLead = (lead) =>
  normalizePhone(lead.phone) === null || (!!String(lead.email ?? "").trim() && normalizeEmail(lead.email) === null);

// Ids of the invalid leads inside `filter`. Validity is decided in JS (the same
// rules that gate new leads), so this scans just phone + email of the scope.
const invalidLeadIds = async (filter) => {
  const rows = await Lead.find(filter).select("phone email").lean();
  return rows.filter(isInvalidLead).map((r) => r._id);
};

// Narrows `filter` to the invalid leads when the request asks for them.
const applyInvalidFilter = async (query, filter) => {
  if (query.invalid !== "1") return filter;
  return { ...filter, _id: { $in: await invalidLeadIds(filter) } };
};

// Deletes invalid leads inside `scope` (this admin's / this caller's leads).
// `ids` deletes just those, `all` deletes every invalid lead in scope. Either
// way only leads that are genuinely invalid go — a stale or hand-edited id list
// can't remove a good lead — and converted leads are kept (they have a student).
const deleteInvalidLeads = async (scope, { ids, all }) => {
  let candidates = await invalidLeadIds({ ...scope, convertedStudent: null });
  if (!all) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
    candidates = candidates.filter((id) => wanted.has(String(id)));
  }
  if (candidates.length === 0) return 0;
  const res = await Lead.deleteMany({ ...scope, _id: { $in: candidates } });
  return res.deletedCount;
};

module.exports = { buildLeadFilter, buildLeadSort, leadSources, invalidLeadIds, applyInvalidFilter, deleteInvalidLeads };
