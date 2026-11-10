const mongoose = require("mongoose");
const Batch = require("../models/Batch");
const Course = require("../models/Course");
const SyllabusProgress = require("../models/SyllabusProgress");

const isId = (v) => mongoose.Types.ObjectId.isValid(v);

// Course syllabus plus which topics this batch has finished.
const buildView = async (course, batch) => {
  const rows = await SyllabusProgress.find({ batch: batch._id, course: course._id });
  const doneAt = new Map(rows.map((r) => [String(r.topicId), r.completedAt]));
  const items = course.syllabusItems || [];
  const units = [];
  const index = new Map();
  for (const t of items) {
    const name = t.unit || "";
    if (!index.has(name)) {
      index.set(name, units.length);
      units.push({ name, items: [] });
    }
    const completedAt = doneAt.get(String(t._id)) || null;
    units[index.get(name)].items.push({ _id: t._id, title: t.title, done: !!completedAt, completedAt });
  }
  const done = items.filter((t) => doneAt.has(String(t._id))).length;
  const last = [...doneAt.values()].sort((a, b) => b - a)[0] || null;
  // First unfinished topic in syllabus order: what is being taught next.
  const next = items.find((t) => !doneAt.has(String(t._id)));
  return {
    batch: { _id: batch._id, name: batch.name },
    course: { _id: course._id, name: course.name },
    syllabusText: course.syllabus || "",
    units,
    total: items.length,
    done,
    percent: items.length ? Math.round((done / items.length) * 100) : 0,
    lastCompletedAt: last,
    nextTopic: next ? { _id: next._id, title: next.title, unit: next.unit || "" } : null,
  };
};

const loadBatchCourse = async (batch) => (batch && batch.course ? Course.findById(batch.course) : null);

// ---------- Teacher ----------
const teacherBatch = async (req) => {
  const id = req.params.id;
  if (!isId(id)) return { error: [400, "Invalid batch"] };
  if (!(req.user.batches || []).some((b) => String(b) === id)) return { error: [403, "You are not assigned to this batch"] };
  const batch = await Batch.findById(id);
  if (!batch) return { error: [404, "Batch not found"] };
  return { batch };
};

exports.teacherView = async (req, res) => {
  try {
    const { batch, error } = await teacherBatch(req);
    if (error) return res.status(error[0]).json({ message: error[1] });
    const course = await loadBatchCourse(batch);
    if (!course) return res.json({ syllabus: null, message: "This batch has no course linked yet." });
    res.json({ syllabus: await buildView(course, batch) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// A repeated tick (double click, two teachers) is harmless: the unique index plus upsert.
exports.teacherMark = async (req, res) => {
  try {
    const { batch, error } = await teacherBatch(req);
    if (error) return res.status(error[0]).json({ message: error[1] });
    const { topicId } = req.params;
    if (!isId(topicId)) return res.status(400).json({ message: "Invalid topic" });
    const course = await loadBatchCourse(batch);
    if (!course) return res.status(400).json({ message: "This batch has no course linked yet." });
    if (!(course.syllabusItems || []).some((t) => String(t._id) === topicId)) {
      return res.status(404).json({ message: "Topic not found in this course" });
    }
    if (req.body.done === false) {
      await SyllabusProgress.deleteOne({ batch: batch._id, topicId });
    } else {
      try {
        await SyllabusProgress.updateOne(
          { batch: batch._id, topicId },
          { $setOnInsert: { admin: batch.admin, course: course._id, completedAt: new Date(), completedBy: req.user._id } },
          { upsert: true }
        );
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
    }
    res.json({ syllabus: await buildView(course, batch) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ---------- Student ----------
exports.studentView = async (req, res) => {
  try {
    if (!req.user.batch) return res.json({ syllabus: null, message: "You are not in a batch yet." });
    const batch = await Batch.findById(req.user.batch);
    const course = await loadBatchCourse(batch);
    if (!course) return res.json({ syllabus: null, message: "Your batch has no course syllabus yet." });
    res.json({ syllabus: await buildView(course, batch) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ---------- Admin ----------
// How far each batch of a course has got.
exports.adminCourseProgress = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid course" });
    const course = await Course.findOne({ _id: req.params.id, admin: req.user._id });
    if (!course) return res.status(404).json({ message: "Course not found" });
    const batches = await Batch.find({ admin: req.user._id, course: course._id }).sort({ name: 1 });
    const views = await Promise.all(batches.map((b) => buildView(course, b)));
    res.json({
      total: (course.syllabusItems || []).length,
      batches: views.map((v) => ({
        batch: v.batch,
        done: v.done,
        total: v.total,
        percent: v.percent,
        lastCompletedAt: v.lastCompletedAt,
        nextTopic: v.nextTopic,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
