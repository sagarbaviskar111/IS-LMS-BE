const Batch = require("../models/Batch");
const User = require("../models/User");
const paginate = require("../utils/paginate");

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
    const { name, description, studentIds, teacherIds, defaultFee, paymentCycleDays } = req.body;
    if (!name) {
      return res.status(400).json({ message: "name is required" });
    }

    const existing = await Batch.findOne({ admin: req.user._id, name });
    if (existing) {
      return res.status(409).json({ message: "A batch with this name already exists" });
    }

    const batch = await Batch.create({
      name,
      description,
      admin: req.user._id,
      defaultFee: typeof defaultFee === "number" && defaultFee >= 0 ? defaultFee : 0,
      paymentCycleDays:
        typeof paymentCycleDays === "number" && paymentCycleDays >= 1 ? paymentCycleDays : 30,
    });

    if (studentIds || teacherIds) {
      await applyMembers(req.user._id, batch._id, { studentIds, teacherIds });
    }

    res.status(201).json({ batch });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listBatches = async (req, res) => {
  try {
    const filter = { admin: req.user._id };
    const { page, limit, skip } = paginate(req);

    const [batches, total] = await Promise.all([
      Batch.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Batch.countDocuments(filter),
    ]);

    const counts = await User.aggregate([
      { $match: { admin: req.user._id, role: { $in: ["student", "teacher"] } } },
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

    const { name, description, defaultFee, paymentCycleDays } = req.body;

    if (name !== undefined && name !== batch.name) {
      const existing = await Batch.findOne({ admin: req.user._id, name, _id: { $ne: batch._id } });
      if (existing) {
        return res.status(409).json({ message: "A batch with this name already exists" });
      }
      batch.name = name;
    }
    if (description !== undefined) batch.description = description;
    if (typeof defaultFee === "number" && defaultFee >= 0) batch.defaultFee = defaultFee;
    if (typeof paymentCycleDays === "number" && paymentCycleDays >= 1) batch.paymentCycleDays = paymentCycleDays;

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
