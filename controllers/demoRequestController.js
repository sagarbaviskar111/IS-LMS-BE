const mongoose = require("mongoose");
const DemoRequest = require("../models/DemoRequest");
const User = require("../models/User");
const { notifyUsers } = require("../utils/notify");

const { STUDENT_BANDS, STATUSES } = DemoRequest;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v, max) => String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, max);
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const shape = (d) => ({
  _id: d._id,
  name: d.name,
  phone: d.phone,
  email: d.email,
  instituteName: d.instituteName,
  city: d.city,
  studentCount: d.studentCount,
  currentTool: d.currentTool,
  preferredTime: d.preferredTime,
  message: d.message,
  source: d.source,
  status: d.status,
  followUpAt: d.followUpAt,
  note: d.note,
  createdAt: d.createdAt,
});

// Public: the website's "Book a demo" form.
exports.create = async (req, res) => {
  try {
    // A hidden field people never fill and bots do. Pretend it worked.
    if (req.body.website) return res.status(201).json({ ok: true });

    const name = clean(req.body.name, 80);
    const phone = clean(req.body.phone, 20);
    const email = clean(req.body.email, 120).toLowerCase();
    const instituteName = clean(req.body.instituteName, 120);
    const city = clean(req.body.city, 60);
    if (name.length < 2) return res.status(400).json({ message: "Enter your name" });
    if (!/^[0-9+\-\s()]{10,18}$/.test(phone) || phone.replace(/\D/g, "").length < 10) {
      return res.status(400).json({ message: "Enter a valid mobile number" });
    }
    if (instituteName.length < 2) return res.status(400).json({ message: "Enter your institute name" });
    if (city.length < 2) return res.status(400).json({ message: "Enter your city" });
    if (!STUDENT_BANDS.includes(req.body.studentCount) || !req.body.studentCount) {
      return res.status(400).json({ message: "Select how many students you have" });
    }
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ message: "Enter a valid email address" });

    // The same person submitting twice (double click, refresh) must not make two leads.
    const digits = phone.replace(/\D/g, "").slice(-10);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (await DemoRequest.findOne({ createdAt: { $gte: since }, phone: new RegExp(`${digits}$`) })) {
      return res.status(201).json({ ok: true });
    }

    const doc = await DemoRequest.create({
      name,
      phone,
      email,
      instituteName,
      city,
      studentCount: req.body.studentCount,
      currentTool: clean(req.body.currentTool, 80),
      preferredTime: clean(req.body.preferredTime, 60),
      message: clean(req.body.message, 1000),
      source: clean(req.body.source, 120) || "website",
    });

    const admins = await User.find({ role: "superadmin", isActive: true }).select("_id role");
    if (admins.length) {
      await notifyUsers(admins[0], admins.map((a) => a._id), "New demo request", `${doc.name}, ${doc.instituteName} (${doc.city}) - ${doc.phone}`);
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("[demo-request]", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};

exports.list = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = {};
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (req.query.due === "1") filter.followUpAt = { $lte: new Date(), $ne: null };
    const q = clean(req.query.q, 60);
    if (q) {
      const rx = new RegExp(escapeRx(q), "i");
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }, { instituteName: rx }, { city: rx }];
    }
    const [rows, total, counts] = await Promise.all([
      DemoRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      DemoRequest.countDocuments(filter),
      DemoRequest.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const c of counts) byStatus[c._id] = c.n;
    res.json({
      requests: rows.map(shape),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts: byStatus,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.update = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid request" });
    const set = {};
    if (req.body.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ message: "Invalid status" });
      set.status = req.body.status;
    }
    if (req.body.note !== undefined) set.note = clean(req.body.note, 1000);
    if (req.body.followUpAt !== undefined) {
      if (req.body.followUpAt === null || req.body.followUpAt === "") set.followUpAt = null;
      else {
        const d = new Date(req.body.followUpAt);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "Invalid follow-up date" });
        set.followUpAt = d;
      }
    }
    const doc = await DemoRequest.findByIdAndUpdate(req.params.id, set, { new: true });
    if (!doc) return res.status(404).json({ message: "Request not found" });
    res.json({ request: shape(doc) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.remove = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: "Invalid request" });
    await DemoRequest.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
