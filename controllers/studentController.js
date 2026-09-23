const Batch = require("../models/Batch");
const Material = require("../models/Material");
const Session = require("../models/Session");
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const Payment = require("../models/Payment");
const paginate = require("../utils/paginate");
const { withFileUrl } = require("../utils/fileUrlView");
const { isRecordingBlocked } = require("../utils/recordingAccess");

exports.myBatch = async (req, res) => {
  try {
    if (!req.user.batch) return res.json({ batch: null });
    const batch = await Batch.findById(req.user.batch);
    res.json({ batch });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listSessions = async (req, res) => {
  try {
    if (!req.user.batch) return res.json({ sessions: [] });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const sessions = await Session.find({
      batch: req.user.batch,
      date: { $gte: startOfToday },
    }).sort({ date: 1, startTime: 1 });

    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.myAttendance = async (req, res) => {
  try {
    if (!req.user.batch) {
      return res.json({ present: 0, total: 0, percentage: null, sessions: [] });
    }

    const attendanceDocs = await Attendance.find({ batch: req.user.batch }).populate(
      "session",
      "topic date startTime endTime"
    );

    let present = 0;
    let total = 0;
    const sessions = [];

    for (const doc of attendanceDocs) {
      const record = doc.records.find((r) => String(r.student) === String(req.user._id));
      if (!record) continue; // wasn't enrolled in this batch when it was marked
      total += 1;
      if (record.status === "present") present += 1;
      sessions.push({ session: doc.session, status: record.status });
    }

    sessions.sort((a, b) => {
      const da = a.session ? new Date(a.session.date).getTime() : 0;
      const db = b.session ? new Date(b.session.date).getTime() : 0;
      return da - db;
    });

    res.json({
      present,
      total,
      percentage: total > 0 ? Math.round((present / total) * 1000) / 10 : null,
      sessions,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.classmates = async (req, res) => {
  try {
    if (!req.user.batch) return res.json({ students: [], teachers: [] });

    const [students, teachers] = await Promise.all([
      User.find({
        role: "student",
        batch: req.user.batch,
        isActive: true,
        _id: { $ne: req.user._id },
      }).select("name email"),
      User.find({ role: "teacher", batches: req.user.batch, isActive: true }).select("name email"),
    ]);

    res.json({ students, teachers });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.myPayments = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = { student: req.user._id };
    const [history, total] = await Promise.all([
      Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Payment.countDocuments(filter),
    ]);

    res.json({
      summary: {
        installmentAmount: req.user.installmentAmount,
        balanceDue: req.user.balanceDue,
        nextDueDate: req.user.nextDueDate,
        paymentGraceUntil: req.user.paymentGraceUntil,
      },
      history,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listMaterials = async (req, res) => {
  try {
    if (!req.user.batch) return res.json({ materials: [] });
    const materials = await Material.find({ batch: req.user.batch })
      .populate("session", "topic date startTime endTime")
      .sort({ createdAt: -1 });

    const result = materials.map((m) => {
      const view = withFileUrl(m);
      if (view.type === "video" && view.session && isRecordingBlocked(req.user, view.session.date)) {
        view.locked = true;
        view.lockedReason = "Recording access is currently blocked. Contact your admin.";
        view.youtubeVideoId = null;
        view.fileUrl = null;
      }
      return view;
    });

    res.json({ materials: result });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
