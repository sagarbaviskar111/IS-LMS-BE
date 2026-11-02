const mongoose = require("mongoose");
const FinanceEntry = require("../models/FinanceEntry");
const Payment = require("../models/Payment");
const User = require("../models/User");
const paginate = require("../utils/paginate");
const { pickSort } = require("../utils/listQuery");

const round2 = (n) => Math.round(n * 100) / 100;
const METHODS = ["cash", "upi", "bank", "card", "cheque", "other"];
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One chronological ledger: the admin's manual entries plus every paid student
// payment (as a credit under "Student fees"), so fees show up without being
// typed in twice.
const ledgerBase = (adminId) => [
  { $match: { admin: adminId } },
  {
    $project: {
      type: 1,
      amount: 1,
      category: 1,
      title: 1,
      note: 1,
      method: 1,
      date: 1,
      source: { $literal: "manual" },
    },
  },
  {
    $unionWith: {
      coll: Payment.collection.name,
      pipeline: [
        { $match: { admin: adminId, status: "paid" } },
        { $lookup: { from: User.collection.name, localField: "student", foreignField: "_id", as: "stu" } },
        {
          $project: {
            type: { $literal: "credit" },
            amount: 1,
            category: { $literal: "Student fees" },
            title: {
              $concat: [
                {
                  $ifNull: [
                    { $arrayElemAt: ["$stu.name", 0] },
                    { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$studentName", ""] } }, 0] }, "$studentName", "Student"] },
                  ],
                },
                " - fee payment",
              ],
            },
            note: { $ifNull: ["$note", ""] },
            method: { $cond: [{ $eq: ["$method", "manual"] }, "cash", "online"] },
            date: "$createdAt",
            source: { $literal: "payment" },
          },
        },
      ],
    },
  },
];

const LEDGER_SORTS = {
  newest: { date: -1, _id: -1 },
  oldest: { date: 1, _id: 1 },
  amount_desc: { amount: -1, _id: -1 },
  amount_asc: { amount: 1, _id: 1 },
};

const filterStage = (q) => {
  const match = {};
  if (q.type === "credit" || q.type === "debit") match.type = q.type;
  if (q.source === "manual" || q.source === "payment") match.source = q.source;
  if (q.category) match.category = String(q.category);
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
    match.date = {};
    if (from && !Number.isNaN(from.getTime())) match.date.$gte = from;
    if (to && !Number.isNaN(to.getTime())) match.date.$lte = to;
  }
  if (q.q) {
    const rx = new RegExp(escapeRegex(String(q.q).slice(0, 80)), "i");
    match.$or = [{ title: rx }, { note: rx }, { category: rx }];
  }
  return { $match: match };
};

exports.listEntries = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req, 20, 200);
    const [out] = await FinanceEntry.aggregate([
      ...ledgerBase(req.user._id),
      filterStage(req.query),
      { $sort: pickSort(req.query.sort, LEDGER_SORTS, "newest") },
      { $facet: { rows: [{ $skip: skip }, { $limit: limit }], count: [{ $count: "n" }] } },
    ]);
    const total = out.count[0]?.n || 0;
    res.json({ entries: out.rows, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Totals for the same filters as the ledger (type/source/search are ignored:
// the summary is always credit vs debit for the chosen date range).
exports.summary = async (req, res) => {
  try {
    const range = filterStage({ from: req.query.from, to: req.query.to });
    const adminId = req.user._id;
    const [out] = await FinanceEntry.aggregate([
      ...ledgerBase(adminId),
      range,
      {
        $facet: {
          totals: [{ $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } }],
          byCategory: [
            { $group: { _id: { type: "$type", category: "$category" }, total: { $sum: "$amount" }, count: { $sum: 1 } } },
            { $sort: { total: -1 } },
          ],
          monthly: [
            {
              $group: {
                _id: { m: { $dateToString: { format: "%Y-%m", date: "$date" } }, type: "$type" },
                total: { $sum: "$amount" },
              },
            },
            { $sort: { "_id.m": 1 } },
          ],
        },
      },
    ]);

    const sum = (type) => round2(out.totals.find((t) => t._id === type)?.total || 0);
    const count = out.totals.reduce((n, t) => n + t.count, 0);
    const credit = sum("credit");
    const debit = sum("debit");

    const monthMap = new Map();
    for (const r of out.monthly) {
      const row = monthMap.get(r._id.m) || { month: r._id.m, credit: 0, debit: 0 };
      row[r._id.type] = round2(r.total);
      monthMap.set(r._id.m, row);
    }

    const categories = (type) =>
      out.byCategory
        .filter((c) => c._id.type === type)
        .map((c) => ({ category: c._id.category, total: round2(c.total), count: c.count }));

    // Fees students still owe (not part of the ledger until they pay).
    const [owed] = await User.aggregate([
      { $match: { role: "student", admin: adminId, archivedAt: null, balanceDue: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$balanceDue" }, students: { $sum: 1 } } },
    ]);

    res.json({
      credit,
      debit,
      net: round2(credit - debit),
      count,
      receivable: round2(owed?.total || 0),
      receivableStudents: owed?.students || 0,
      credits: categories("credit"),
      debits: categories("debit"),
      monthly: [...monthMap.values()].slice(-12),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Categories the admin has used before, for the entry form's suggestions.
exports.categories = async (req, res) => {
  try {
    const rows = await FinanceEntry.aggregate([
      { $match: { admin: req.user._id } },
      { $group: { _id: { type: "$type", category: "$category" } } },
    ]);
    res.json({
      credit: rows.filter((r) => r._id.type === "credit").map((r) => r._id.category).sort(),
      debit: rows.filter((r) => r._id.type === "debit").map((r) => r._id.category).sort(),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const readEntry = (b) => {
  const type = b.type;
  if (type !== "credit" && type !== "debit") return { error: "Choose credit or debit" };
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return { error: "Enter a valid amount" };
  const category = String(b.category || "").trim().slice(0, 60);
  if (!category) return { error: "Choose or type a category" };
  const title = String(b.title || "").trim().slice(0, 120);
  if (!title) return { error: "Add a short title" };
  const date = b.date ? new Date(b.date) : new Date();
  if (Number.isNaN(date.getTime())) return { error: "Enter a valid date" };
  const method = METHODS.includes(b.method) ? b.method : "cash";
  return { value: { type, amount: round2(amount), category, title, note: String(b.note || "").trim().slice(0, 500), method, date } };
};

exports.createEntry = async (req, res) => {
  try {
    const { value, error } = readEntry(req.body || {});
    if (error) return res.status(400).json({ message: error });
    const entry = await FinanceEntry.create({ ...value, admin: req.user._id, createdBy: req.user._id });
    res.status(201).json({ entry });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateEntry = async (req, res) => {
  try {
    const entry = await FinanceEntry.findOne({ _id: req.params.id, admin: req.user._id }).catch(() => null);
    if (!entry) return res.status(404).json({ message: "Entry not found" });
    const { value, error } = readEntry({ ...entry.toObject(), ...req.body });
    if (error) return res.status(400).json({ message: error });
    Object.assign(entry, value);
    await entry.save();
    res.json({ entry });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteEntry = async (req, res) => {
  try {
    const entry = await FinanceEntry.findOneAndDelete({ _id: req.params.id, admin: req.user._id }).catch(() => null);
    if (!entry) return res.status(404).json({ message: "Entry not found" });
    res.json({ message: "Entry deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const csvCell = (v) => {
  let s = String(v ?? "");
  // Stop spreadsheet formula injection from user-typed text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

exports.exportCsv = async (req, res) => {
  try {
    const rows = await FinanceEntry.aggregate([
      ...ledgerBase(req.user._id),
      filterStage(req.query),
      { $sort: pickSort(req.query.sort, LEDGER_SORTS, "newest") },
      { $limit: 10000 },
    ]);
    const lines = [["Date", "Type", "Category", "Title", "Method", "Credit", "Debit", "Note", "Source"].join(",")];
    for (const r of rows) {
      lines.push(
        [
          new Date(r.date).toISOString().slice(0, 10),
          r.type,
          r.category,
          r.title,
          r.method,
          r.type === "credit" ? r.amount : "",
          r.type === "debit" ? r.amount : "",
          r.note,
          r.source === "payment" ? "Student payment" : "Manual",
        ]
          .map(csvCell)
          .join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="finance-ledger.csv"');
    res.send("\uFEFF" + lines.join("\n"));
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
