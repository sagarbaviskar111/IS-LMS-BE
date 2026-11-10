const crypto = require("crypto");
const Course = require("../models/Course");
const SyllabusProgress = require("../models/SyllabusProgress");
const paginate = require("../utils/paginate");
const { searchRegex, pickSort, CASE_INSENSITIVE } = require("../utils/listQuery");

const MODES = ["online", "offline", "hybrid"];
const LEVELS = ["beginner", "intermediate", "advanced", "all"];
const UNITS = ["days", "weeks", "months"];

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

// Validates the request body and returns { error } or { data } ready for Mongoose.
// Only keys present in the body are returned, so PATCH can reuse it.
const parseCourse = (body, { partial }) => {
  const data = {};
  const has = (k) => body[k] !== undefined;

  if (has("name") || !partial) {
    const name = String(body.name || "").trim();
    if (!name) return { error: "Course name is required" };
    data.name = name;
  }
  if (has("description")) data.description = String(body.description || "").trim();
  if (has("language")) data.language = String(body.language || "").trim();
  if (has("prerequisites")) data.prerequisites = String(body.prerequisites || "").trim();
  if (has("level")) {
    if (!LEVELS.includes(body.level)) return { error: "Invalid level" };
    data.level = body.level;
  }
  if (has("mode")) {
    if (!MODES.includes(body.mode)) return { error: "Invalid course mode" };
    data.mode = body.mode;
  }
  if (has("durationUnit")) {
    if (!UNITS.includes(body.durationUnit)) return { error: "Invalid duration unit" };
    data.durationUnit = body.durationUnit;
  }
  if (has("durationValue")) {
    const n = Number(body.durationValue);
    if (!Number.isFinite(n) || n < 0) return { error: "Duration must be a positive number" };
    data.durationValue = n;
  }
  if (has("terms")) {
    const text = String(body.terms || "").trim();
    if (text.length > 20000) return { error: "Terms are too long (max 20,000 characters)" };
    data.terms = text;
  }
  if (has("isActive")) data.isActive = !!body.isActive;

  // ---- payment ----
  if (has("oneTimeEnabled")) data.oneTimeEnabled = !!body.oneTimeEnabled;
  if (has("installmentEnabled")) data.installmentEnabled = !!body.installmentEnabled;
  if (has("oneTimeAmount")) {
    const n = money(body.oneTimeAmount);
    if (n === null) return { error: "One-time amount is invalid" };
    data.oneTimeAmount = n;
  }
  if (has("installmentCharge")) {
    const n = money(body.installmentCharge || 0);
    if (n === null) return { error: "Installment charge is invalid" };
    data.installmentCharge = n;
  }
  if (has("installments")) {
    if (!Array.isArray(body.installments)) return { error: "Installments must be a list" };
    if (body.installments.length > 24) return { error: "Too many installments (max 24)" };
    const items = [];
    for (let i = 0; i < body.installments.length; i++) {
      const it = body.installments[i] || {};
      const amount = money(it.amount);
      const due = Number(it.dueAfterDays || 0);
      if (amount === null || amount <= 0) return { error: `Installment ${i + 1}: enter an amount` };
      if (!Number.isInteger(due) || due < 0) return { error: `Installment ${i + 1}: due days must be 0 or more` };
      items.push({ label: String(it.label || "").trim().slice(0, 60), amount, dueAfterDays: due });
    }
    data.installments = items;
  }

  if (has("syllabus")) {
    const text = String(body.syllabus || "").trim();
    if (text.length > 30000) return { error: "Syllabus is too long (max 30,000 characters)" };
    data.syllabus = text;
  }

  if (has("syllabusItems")) {
    if (!Array.isArray(body.syllabusItems)) return { error: "Syllabus topics must be a list" };
    if (body.syllabusItems.length > 400) return { error: "Too many syllabus topics (max 400)" };
    const items = [];
    for (let i = 0; i < body.syllabusItems.length; i++) {
      const it = body.syllabusItems[i] || {};
      const title = String(it.title || "").trim().slice(0, 160);
      if (!title) return { error: `Topic ${i + 1}: enter a title` };
      const entry = { unit: String(it.unit || "").trim().slice(0, 80), title };
      if (it._id && /^[0-9a-f]{24}$/i.test(String(it._id))) entry._id = it._id;
      items.push(entry);
    }
    data.syllabusItems = items;
  }

  return { data };
};

// Cross-field rules, checked against the final merged values.
const checkConsistency = (c) => {
  if (!c.oneTimeEnabled && !c.installmentEnabled) return "Turn on at least one payment option";
  if (c.oneTimeEnabled && !(c.oneTimeAmount > 0)) return "Enter the one-time payment amount";
  if (c.installmentEnabled && (!c.installments || c.installments.length < 2)) {
    return "Add at least 2 installments (or turn installments off)";
  }
  return null;
};

exports.createCourse = async (req, res) => {
  try {
    const { error, data } = parseCourse(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ message: error });
    const problem = checkConsistency({ oneTimeEnabled: true, ...data });
    if (problem) return res.status(400).json({ message: problem });

    if (await Course.findOne({ admin: req.user._id, name: data.name })) {
      return res.status(409).json({ message: "A course with this name already exists" });
    }
    const course = await Course.create({
      ...data,
      admin: req.user._id,
      registrationToken: crypto.randomBytes(16).toString("hex"),
    });
    res.status(201).json({ course });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listCourses = async (req, res) => {
  try {
    const filter = { admin: req.user._id };
    if (req.query.active === "1") filter.isActive = true;
    if (req.query.active === "0") filter.isActive = false;
    const rx = searchRegex(req.query.q);
    if (rx) filter.name = rx;
    if (MODES.includes(req.query.mode)) filter.mode = req.query.mode;
    const sort = pickSort(
      req.query.sort,
      {
        newest: { createdAt: -1 },
        oldest: { createdAt: 1 },
        name_asc: { name: 1, _id: 1 },
        name_desc: { name: -1, _id: 1 },
        fee_asc: { oneTimeAmount: 1, _id: 1 },
        fee_desc: { oneTimeAmount: -1, _id: 1 },
      },
      "newest"
    );
    const { page, limit, skip } = paginate(req, 12);
    const [courses, total] = await Promise.all([
      // lean(): read as plain data, so one old/odd document can never make the
      // whole list fail Mongoose validation or casting.
      Course.find(filter).collation(CASE_INSENSITIVE).sort(sort).skip(skip).limit(limit).lean(),
      Course.countDocuments(filter),
    ]);
    for (const c of courses) {
      // Courses made before registration links existed get theirs on first view.
      if (!c.registrationToken) {
        c.registrationToken = crypto.randomBytes(16).toString("hex");
        await Course.updateOne({ _id: c._id }, { $set: { registrationToken: c.registrationToken } });
      }
      // Fields added later may be missing on older documents.
      if (typeof c.syllabus !== "string") c.syllabus = "";
      c.terms = c.terms || "";
      c.installmentCharge = c.installmentCharge || 0;
      c.installments = c.installments || [];
    }
    res.json({ courses, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateCourse = async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.id, admin: req.user._id });
    if (!course) return res.status(404).json({ message: "Course not found" });

    const { error, data } = parseCourse(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ message: error });

    const merged = { ...course.toObject(), ...data };
    const problem = checkConsistency(merged);
    if (problem) return res.status(400).json({ message: problem });

    if (data.name && data.name !== course.name) {
      if (await Course.findOne({ admin: req.user._id, name: data.name, _id: { $ne: course._id } })) {
        return res.status(409).json({ message: "A course with this name already exists" });
      }
    }
    course.set(data);
    await course.save();
    if (data.syllabusItems) {
      // Topics removed from the syllabus must not leave ticks behind.
      await SyllabusProgress.deleteMany({ course: course._id, topicId: { $nin: course.syllabusItems.map((t) => t._id) } });
    }
    res.json({ course });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteCourse = async (req, res) => {
  try {
    const course = await Course.findOneAndDelete({ _id: req.params.id, admin: req.user._id });
    if (!course) return res.status(404).json({ message: "Course not found" });
    res.json({ message: "Course deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
