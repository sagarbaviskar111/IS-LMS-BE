const crypto = require("crypto");
const Lead = require("../models/Lead");
const User = require("../models/User");
const Payment = require("../models/Payment");
const paginate = require("../utils/paginate");
const { DAY_MS } = require("../utils/paymentCycle");

// Round-robin: whichever active telecaller currently has the fewest leads gets the next one,
// so leads are distributed evenly one-by-one rather than clustering.
const assignTelecaller = async (adminId) => {
  const telecallers = await User.find({ admin: adminId, role: "telecaller", isActive: true }).select("_id");
  if (telecallers.length === 0) return null;

  const counts = await Lead.aggregate([
    { $match: { admin: adminId, assignedTelecaller: { $ne: null } } },
    { $group: { _id: "$assignedTelecaller", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  let chosen = telecallers[0];
  let minCount = Infinity;
  for (const t of telecallers) {
    const c = countMap.get(String(t._id)) || 0;
    if (c < minCount) {
      minCount = c;
      chosen = t;
    }
  }
  return chosen._id;
};

exports.createLead = async (req, res) => {
  try {
    const { name, phone, email, notes } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ message: "name and phone are required" });
    }

    const assignedTelecaller = await assignTelecaller(req.user._id);
    if (!assignedTelecaller) {
      return res.status(400).json({ message: "No active telecallers available to assign this lead to" });
    }

    const lead = await Lead.create({
      admin: req.user._id,
      name,
      phone,
      email,
      notes,
      assignedTelecaller,
      createdBy: req.user._id,
    });

    const populated = await lead.populate("assignedTelecaller", "name email");
    res.status(201).json({ lead: populated });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Public — no session, authenticated purely by the per-admin key in the
// URL. Used by external sources (a Google Sheet via a pasted Apps Script
// trigger, another website's backend, Zapier, etc.) to push leads straight
// in. Unlike the manual createLead above, a missing telecaller doesn't
// reject the request — dropping data from an unattended integration would
// be worse than leaving a lead unassigned for the admin to sort out later.
exports.ingestWebhookLead = async (req, res) => {
  try {
    const admin = await User.findOne({ role: "admin", leadWebhookKey: req.params.apiKey });
    if (!admin) {
      return res.status(401).json({ message: "Invalid webhook key" });
    }

    const { name, phone, email, notes, source } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ message: "name and phone are required" });
    }
    const cleanPhone = String(phone).trim();

    // Re-sent on every edit (a Google Sheet trigger fires on any change to
    // the sheet, not just new rows) — match on phone within this admin's
    // leads and update in place instead of piling up duplicates.
    const existing = await Lead.findOne({ admin: admin._id, phone: cleanPhone });
    if (existing) {
      existing.name = name;
      if (email !== undefined) existing.email = email;
      if (notes !== undefined) existing.notes = notes;
      await existing.save();
      return res.json({ message: "Lead updated", lead: existing });
    }

    const assignedTelecaller = await assignTelecaller(admin._id);
    const lead = await Lead.create({
      admin: admin._id,
      createdBy: admin._id,
      name,
      phone: cleanPhone,
      email,
      notes,
      assignedTelecaller,
      source: "webhook",
      sourceLabel: source ? String(source).trim().slice(0, 60) : "External",
    });
    res.status(201).json({ message: "Lead created", lead });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listLeads = async (req, res) => {
  try {
    const filter = { admin: req.user._id };
    const { page, limit, skip } = paginate(req);

    const [leads, total] = await Promise.all([
      Lead.find(filter)
        .populate("assignedTelecaller", "name email")
        .populate("convertedStudent", "name email")
        .populate("convertedBy", "name email role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Lead.countDocuments(filter),
    ]);

    res.json({ leads, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getLead = async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, admin: req.user._id })
      .populate("assignedTelecaller", "name email")
      .populate("convertedStudent", "name email")
      .populate("convertedBy", "name email role")
      .populate("callLogs.calledBy", "name email");
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json({ lead });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.reassignLead = async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, admin: req.user._id });
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const { telecallerId } = req.body;
    if (!telecallerId) return res.status(400).json({ message: "telecallerId is required" });

    const telecaller = await User.findOne({ _id: telecallerId, admin: req.user._id, role: "telecaller" });
    if (!telecaller) return res.status(400).json({ message: "Invalid telecaller" });

    lead.assignedTelecaller = telecaller._id;
    await lead.save();

    const populated = await lead.populate("assignedTelecaller", "name email");
    res.json({ lead: populated });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.registerLead = async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, admin: req.user._id });
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.convertedStudent) {
      return res.status(400).json({ message: "This lead has already been converted" });
    }

    const { name, email, password, phone, feeAmount, amountPaidNow } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email and password are required" });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: "A user with this email already exists" });
    }

    const fee = typeof feeAmount === "number" && feeAmount >= 0 ? feeAmount : lead.feeAmount || 0;
    const paidNow = typeof amountPaidNow === "number" && amountPaidNow > 0 ? amountPaidNow : 0;

    const student = await User.create({
      name,
      email,
      password,
      phone: phone || lead.phone,
      role: "student",
      admin: req.user._id,
      isActive: true,
      createdBy: req.user._id,
      installmentAmount: fee,
      balanceDue: Math.max(0, fee - paidNow),
      // Only start a payment cycle if there's actually a fee, so a 0-fee
      // student can still pick up a batch's default fee once assigned.
      nextDueDate: fee > 0 ? new Date(Date.now() + 30 * DAY_MS) : null,
    });

    if (paidNow > 0) {
      await Payment.create({
        student: student._id,
        admin: req.user._id,
        amount: paidNow,
        method: "manual",
        status: "paid",
        recordedBy: req.user._id,
        note: "Collected at registration",
      });
    }

    lead.feeAmount = fee;
    lead.convertedStudent = student._id;
    lead.convertedBy = req.user._id;
    lead.status = "converted";
    await lead.save();

    res.status(201).json({ student: student.toJSON(), lead });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.generateRegistrationLink = async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, admin: req.user._id });
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.convertedStudent) {
      return res.status(400).json({ message: "This lead has already been converted" });
    }

    const { feeAmount } = req.body;
    if (typeof feeAmount === "number" && feeAmount >= 0) {
      lead.feeAmount = feeAmount;
    }

    if (!lead.registrationToken) {
      lead.registrationToken = crypto.randomBytes(16).toString("hex");
    }
    await lead.save();

    res.json({ token: lead.registrationToken, feeAmount: lead.feeAmount });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
