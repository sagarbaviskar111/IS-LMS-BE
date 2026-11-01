const { paymentDeadline, DAY_MS } = require("../utils/paymentCycle");
const { getFeeStatus, closeOutIfFullyPaid } = require("../utils/feeStatus");
const { syncFromSchedule, publicSchedule, hasSchedule } = require("../utils/installmentSchedule");
const Batch = require("../models/Batch");
const Material = require("../models/Material");
const Session = require("../models/Session");
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const Payment = require("../models/Payment");
const paginate = require("../utils/paginate");
const { withFileUrl } = require("../utils/fileUrlView");
const { attachPlaybackUrls } = require("../utils/objectStorage");
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
    const { page, limit, skip } = paginate(req);
    if (!req.user.batch) {
      return res.json({ sessions: [], total: 0, page, limit, totalPages: 1 });
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const filter = { batch: req.user.batch, date: { $gte: startOfToday } };

    const [sessions, total] = await Promise.all([
      Session.find(filter).sort({ date: 1, startTime: 1 }).skip(skip).limit(limit),
      Session.countDocuments(filter),
    ]);

    res.json({ sessions, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.myAttendance = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    if (!req.user.batch) {
      return res.json({ present: 0, total: 0, percentage: null, sessions: [], page, limit, totalPages: 1 });
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

    // Most recent first — the aggregate present/total/percentage above still
    // covers the full history regardless of which page of it is returned.
    sessions.sort((a, b) => {
      const da = a.session ? new Date(a.session.date).getTime() : 0;
      const db = b.session ? new Date(b.session.date).getTime() : 0;
      return db - da;
    });

    res.json({
      present,
      total,
      percentage: total > 0 ? Math.round((present / total) * 1000) / 10 : null,
      sessions: sessions.slice(skip, skip + limit),
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(sessions.length / limit)),
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

// Days the next due date moves out when an installment is paid early.
const cycleDaysOf = async (student) => {
  const batch = student.batch ? await Batch.findById(student.batch).select("paymentCycleDays") : null;
  return batch?.paymentCycleDays || 30;
};

// Pays the next installment ahead of time: records the payment and pushes the
// due date out by one cycle. Only allowed once the current balance is clear.
exports.payNextInstallment = async (req, res) => {
  try {
    const student = req.user;
    if (hasSchedule(student)) {
      return res.status(400).json({ message: "Your installments follow a fixed schedule — pay the current one above" });
    }
    if (!(student.installmentAmount > 0) || !student.nextDueDate) {
      return res.status(400).json({ message: "You have no upcoming installment" });
    }
    if (student.balanceDue > 0) {
      return res.status(400).json({ message: "Clear your current balance due first" });
    }
    // Never take more than what's left of the course fee.
    const feeStatus = await getFeeStatus(student);
    if (feeStatus && feeStatus.remaining <= 0) {
      return res.status(400).json({ message: "Your course fees are already fully paid" });
    }
    const amount = feeStatus ? Math.min(student.installmentAmount, feeStatus.remaining) : student.installmentAmount;

    student.nextDueDate = new Date(student.nextDueDate.getTime() + (await cycleDaysOf(student)) * DAY_MS);
    student.paymentGraceUntil = null;
    student.lastFeeReminderAt = null;
    await student.save();

    await Payment.create({
      student: student._id,
      admin: student.admin,
      batch: student.batch || null,
      amount,
      method: "online",
      status: "paid",
      note: "Next installment paid in advance",
    });
    await closeOutIfFullyPaid(student);

    res.json({ nextDueDate: student.nextDueDate });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.myPayments = async (req, res) => {
  try {
    if (syncFromSchedule(req.user)) await req.user.save();
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
        feeStatus: await getFeeStatus(req.user),
        schedule: publicSchedule(req.user),
        paymentDeadline: paymentDeadline(req.user),
        nextInstallmentDueDate:
          !hasSchedule(req.user) && req.user.nextDueDate && req.user.installmentAmount > 0
            ? new Date(req.user.nextDueDate.getTime() + (await cycleDaysOf(req.user)) * DAY_MS)
            : null,
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
    const { page, limit, skip } = paginate(req);
    if (!req.user.batch) {
      return res.json({ materials: [], total: 0, page, limit, totalPages: 1 });
    }

    const filter = { batch: req.user.batch };
    if (req.query.type) filter.type = req.query.type;

    const [materials, total] = await Promise.all([
      Material.find(filter)
        .populate("session", "topic date startTime endTime")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Material.countDocuments(filter),
    ]);

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
    await attachPlaybackUrls(req.user.admin, result);

    res.json({ materials: result, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
