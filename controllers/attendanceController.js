const mongoose = require("mongoose");
const Attendance = require("../models/Attendance");
const Session = require("../models/Session");
const User = require("../models/User");

const isAssigned = (req, batchId) =>
  (req.user.batches || []).some((b) => String(b) === String(batchId));

exports.getSessionAttendance = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (!isAssigned(req, session.batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const students = await User.find({
      role: "student",
      admin: req.user.admin,
      batch: session.batch,
    }).sort({ name: 1 });

    const attendance = await Attendance.findOne({ session: session._id });
    const statusMap = new Map((attendance?.records || []).map((r) => [String(r.student), r.status]));

    const records = students.map((s) => ({
      student: s._id,
      name: s.name,
      email: s.email,
      status: statusMap.get(String(s._id)) || null,
    }));

    res.json({ records, markedAt: attendance?.updatedAt || null });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.markSessionAttendance = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (!isAssigned(req, session.batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { records } = req.body;
    if (!Array.isArray(records)) {
      return res.status(400).json({ message: "records must be an array" });
    }

    const students = await User.find({
      role: "student",
      admin: req.user.admin,
      batch: session.batch,
    }).select("_id");
    const validIds = students.map((s) => String(s._id));

    const statusMap = new Map(
      records
        .filter((r) => validIds.includes(String(r.student)) && ["present", "absent"].includes(r.status))
        .map((r) => [String(r.student), r.status])
    );

    // Every currently-enrolled student gets a record; anyone not explicitly
    // marked present is recorded absent, so percentages stay accountable.
    const finalRecords = validIds.map((id) => ({
      student: id,
      status: statusMap.get(id) || "absent",
    }));

    const attendance = await Attendance.findOneAndUpdate(
      { session: session._id },
      {
        session: session._id,
        batch: session.batch,
        admin: req.user.admin,
        markedBy: req.user._id,
        records: finalRecords,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ attendance });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.batchAttendanceSummary = async (req, res) => {
  try {
    const batchId = req.params.id;
    if (!isAssigned(req, batchId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const students = await User.find({
      role: "student",
      admin: req.user.admin,
      batch: batchId,
    }).sort({ name: 1 });

    const totals = await Attendance.aggregate([
      { $match: { batch: new mongoose.Types.ObjectId(batchId) } },
      { $unwind: "$records" },
      {
        $group: {
          _id: "$records.student",
          present: { $sum: { $cond: [{ $eq: ["$records.status", "present"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
    ]);

    const totalsMap = new Map(totals.map((t) => [String(t._id), t]));
    const sessionCount = await Attendance.countDocuments({ batch: batchId });

    const summary = students.map((s) => {
      const t = totalsMap.get(String(s._id));
      const present = t?.present || 0;
      const total = t?.total || 0;
      return {
        student: s._id,
        name: s.name,
        email: s.email,
        present,
        total,
        percentage: total > 0 ? Math.round((present / total) * 1000) / 10 : null,
      };
    });

    res.json({ summary, sessionCount });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
