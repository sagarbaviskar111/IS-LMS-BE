const Batch = require("../models/Batch");
const User = require("../models/User");
const paginate = require("../utils/paginate");
const mongoose = require("mongoose");
const { searchRegex, pickSort, CASE_INSENSITIVE } = require("../utils/listQuery");
const Course = require("../models/Course");

const MODES = ["online", "offline", "hybrid"];

// Validates the batch details sent by the admin. Returns { error } or { data }.
// With partial=true only the keys present are checked (PATCH).
const parseBatch = async (adminId, body, { partial, current }) => {
  const data = {};
  const has = (k) => body[k] !== undefined;

  if (has("name") || !partial) {
    const name = String(body.name || "").trim();
    if (!name) return { error: "Batch name is required" };
    data.name = name;
  }
  if (has("description")) data.description = String(body.description || "").trim();

  if (has("course") || !partial) {
    if (!body.course) {
      if (!partial) return { error: "Select a course for this batch" };
    } else {
      const course = await Course.findOne({ _id: body.course, admin: adminId }).catch(() => null);
      if (!course) return { error: "Selected course was not found" };
      data.course = course._id;
      // Mode defaults to the course's mode unless the admin picked one.
      if (!has("mode")) data.mode = course.mode;
    }
  }
  if (has("mode")) {
    if (!MODES.includes(body.mode)) return { error: "Invalid batch mode" };
    data.mode = body.mode;
  }
  for (const key of ["startDate", "endDate"]) {
    if (has(key)) {
      if (!body[key]) data[key] = null;
      else {
        const d = new Date(body[key]);
        if (Number.isNaN(d.getTime())) return { error: `Invalid ${key === "startDate" ? "start" : "end"} date` };
        data[key] = d;
      }
    }
  }
  if (has("maxStudents") || !partial) {
    const n = Number(body.maxStudents || 0);
    if (!Number.isInteger(n) || n < 0) return { error: "Number of students must be a whole number" };
    data.maxStudents = n;
  }

  const start = "startDate" in data ? data.startDate : current?.startDate;
  const end = "endDate" in data ? data.endDate : current?.endDate;
  if (start && end && end < start) return { error: "End date must be after the start date" };
  if ("maxStudents" in data && data.maxStudents > 0 && current) {
    const enrolled = await User.countDocuments({ admin: adminId, role: "student", batch: current._id });
    if (enrolled > data.maxStudents) {
      return { error: `This batch already has ${enrolled} students — number of students can't be lower` };
    }
  }
  return { data };
};


// Students: replace semantics — the given list becomes the batch's full roster,
// which naturally moves a student off whatever batch they were on before.
// Teachers: additive/removable — a teacher can belong to several batches at once.
const applyMembers = async (adminId, batchId, { studentIds, teacherIds }) => {
  if (Array.isArray(studentIds)) {
    await User.updateMany(
      { admin: adminId, role: "student", batch: batchId, _id: { $nin: studentIds } },
      { $set: { batch: null } }
    );
    await User.updateMany(
      { admin: adminId, role: "student", _id: { $in: studentIds } },
      { $set: { batch: batchId } }
    );

    // Newly-added students who don't already have a payment cycle running
    // (no fee decided at registration) pick up the batch's default fee/cycle.
    const batch = await Batch.findById(batchId);
    if (batch && batch.defaultFee > 0) {
      await User.updateMany(
        { admin: adminId, role: "student", _id: { $in: studentIds }, nextDueDate: null },
        {
          $set: {
            installmentAmount: batch.defaultFee,
            balanceDue: batch.defaultFee,
            nextDueDate: new Date(Date.now() + (batch.paymentCycleDays || 30) * 24 * 60 * 60 * 1000),
          },
        }
      );
    }
  }

  if (Array.isArray(teacherIds)) {
    await User.updateMany(
      { admin: adminId, role: "teacher", batches: batchId, _id: { $nin: teacherIds } },
      { $pull: { batches: batchId } }
    );
    await User.updateMany(
      { admin: adminId, role: "teacher", _id: { $in: teacherIds } },
      { $addToSet: { batches: batchId } }
    );
  }
};

exports.createBatch = async (req, res) => {
  try {
    const { error, data } = await parseBatch(req.user._id, req.body || {}, { partial: false });
    if (error) return res.status(400).json({ message: error });

    if (await Batch.findOne({ admin: req.user._id, name: data.name })) {
      return res.status(409).json({ message: "A batch with this name already exists" });
    }
    const batch = await Batch.create({ ...data, admin: req.user._id });
    res.status(201).json({ batch });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listBatches = async (req, res) => {
  try {
    const filter = { admin: req.user._id };
    const rx = searchRegex(req.query.q);
    if (rx) filter.name = rx;
    if (mongoose.isValidObjectId(req.query.course)) filter.course = req.query.course;
    if (MODES.includes(req.query.mode)) filter.mode = req.query.mode;
    const sort = pickSort(
      req.query.sort,
      {
        newest: { createdAt: -1 },
        oldest: { createdAt: 1 },
        name_asc: { name: 1, _id: 1 },
        name_desc: { name: -1, _id: 1 },
        start_asc: { startDate: 1, _id: 1 },
        start_desc: { startDate: -1, _id: 1 },
      },
      "newest"
    );
    const { page, limit, skip } = paginate(req);

    const [batches, total] = await Promise.all([
      Batch.find(filter).collation(CASE_INSENSITIVE).sort(sort).skip(skip).limit(limit).populate("course", "name"),
      Batch.countDocuments(filter),
    ]);

    const counts = await User.aggregate([
      { $match: { admin: req.user._id, archivedAt: null, role: { $in: ["student", "teacher"] } } },
      {
        $facet: {
          students: [
            { $match: { role: "student", batch: { $ne: null } } },
            { $group: { _id: "$batch", count: { $sum: 1 } } },
          ],
          teachers: [
            { $match: { role: "teacher" } },
            { $unwind: "$batches" },
            { $group: { _id: "$batches", count: { $sum: 1 } } },
          ],
        },
      },
    ]);

    const studentCounts = new Map((counts[0]?.students || []).map((c) => [String(c._id), c.count]));
    const teacherCounts = new Map((counts[0]?.teachers || []).map((c) => [String(c._id), c.count]));

    const result = batches.map((b) => ({
      ...b.toObject(),
      studentCount: studentCounts.get(String(b._id)) || 0,
      teacherCount: teacherCounts.get(String(b._id)) || 0,
    }));

    res.json({ batches: result, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateBatch = async (req, res) => {
  try {
    const batch = await Batch.findOne({ _id: req.params.id, admin: req.user._id });
    if (!batch) return res.status(404).json({ message: "Batch not found" });

    const { error, data } = await parseBatch(req.user._id, req.body || {}, { partial: true, current: batch });
    if (error) return res.status(400).json({ message: error });

    if (data.name && data.name !== batch.name) {
      if (await Batch.findOne({ admin: req.user._id, name: data.name, _id: { $ne: batch._id } })) {
        return res.status(409).json({ message: "A batch with this name already exists" });
      }
    }
    batch.set(data);
    await batch.save();
    res.json({ batch });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateBatchMembers = async (req, res) => {
  try {
    const batch = await Batch.findOne({ _id: req.params.id, admin: req.user._id });
    if (!batch) return res.status(404).json({ message: "Batch not found" });

    const { studentIds, teacherIds } = req.body;
    if (Array.isArray(studentIds) && batch.maxStudents > 0 && studentIds.length > batch.maxStudents) {
      return res.status(400).json({
        message: `This batch allows only ${batch.maxStudents} students — you selected ${studentIds.length}`,
      });
    }
    await applyMembers(req.user._id, batch._id, { studentIds, teacherIds });

    res.json({ message: "Batch members updated" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteBatch = async (req, res) => {
  try {
    const batch = await Batch.findOne({ _id: req.params.id, admin: req.user._id });
    if (!batch) return res.status(404).json({ message: "Batch not found" });

    await batch.deleteOne();

    await User.updateMany(
      { admin: req.user._id, role: "student", batch: batch._id },
      { $set: { batch: null } }
    );
    await User.updateMany(
      { admin: req.user._id, role: "teacher", batches: batch._id },
      { $pull: { batches: batch._id } }
    );

    res.json({ message: "Batch deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
