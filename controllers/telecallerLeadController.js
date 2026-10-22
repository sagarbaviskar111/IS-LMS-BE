const Lead = require("../models/Lead");
const User = require("../models/User");
const Payment = require("../models/Payment");
const { CALL_RESPONSES } = require("../models/Lead");
const crypto = require("crypto");
const paginate = require("../utils/paginate");
const {
  buildLeadFilter,
  buildLeadSort,
  leadSources,
  invalidLeadIds,
  applyInvalidFilter,
  deleteInvalidLeads,
} = require("../utils/leadFilters");
const { DAY_MS } = require("../utils/paymentCycle");

const loadOwnedLead = async (req) => {
  const lead = await Lead.findOne({ _id: req.params.id, assignedTelecaller: req.user._id });
  if (!lead) return { error: [404, "Lead not found"] };
  return { lead };
};

const QUICK_MESSAGE_DEFAULTS = require("../utils/quickMessageDefaults");
const MAX_QUICK_MESSAGES = 30;

exports.getQuickMessages = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("quickMessages quickMessagesCustomized");
    // Until they've changed anything, show the starter set (not stored yet).
    if (!user?.quickMessagesCustomized && !user?.quickMessages?.length) return res.json({ messages: QUICK_MESSAGE_DEFAULTS, customized: false });
    res.json({ messages: user.quickMessages.map((m) => ({ _id: m._id, label: m.label, text: m.text })), customized: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Replaces the caller's whole list (the UI adds / edits / removes and saves).
// An empty list is allowed — they may want no quick messages at all.
exports.saveQuickMessages = async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!raw) return res.status(400).json({ message: "messages must be a list" });
    if (raw.length > MAX_QUICK_MESSAGES) {
      return res.status(400).json({ message: `You can save up to ${MAX_QUICK_MESSAGES} quick messages` });
    }
    const messages = [];
    for (const m of raw) {
      const label = String(m?.label ?? "").trim();
      const text = String(m?.text ?? "").trim();
      if (!label || !text) return res.status(400).json({ message: "Each quick message needs a name and a message" });
      if (label.length > 40) return res.status(400).json({ message: "Name can be at most 40 characters" });
      if (text.length > 1000) return res.status(400).json({ message: "Message can be at most 1000 characters" });
      messages.push({ label, text });
    }
    const user = await User.findById(req.user._id);
    user.quickMessages = messages;
    user.quickMessagesCustomized = true;
    await user.save();
    res.json({ messages: user.quickMessages.map((m) => ({ _id: m._id, label: m.label, text: m.text })), customized: true });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.mySourceOptions = async (req, res) => {
  try {
    res.json({ sources: await leadSources({ assignedTelecaller: req.user._id }) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listMyLeads = async (req, res) => {
  try {
    const scope = { assignedTelecaller: req.user._id };
    const filter = await applyInvalidFilter(req.query, buildLeadFilter(req.query, scope));
    const { page, limit, skip } = paginate(req);

    const [leads, total, invalidCount] = await Promise.all([
      Lead.find(filter).sort(buildLeadSort(req.query)).skip(skip).limit(limit),
      Lead.countDocuments(filter),
      invalidLeadIds(scope).then((ids) => ids.length),
    ]);

    res.json({ leads, total, invalidCount, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteMyInvalidLeads = async (req, res) => {
  try {
    const { ids, all } = req.body || {};
    if (all !== true && !(Array.isArray(ids) && ids.length)) {
      return res.status(400).json({ message: "Select at least one lead" });
    }
    const deleted = await deleteInvalidLeads({ assignedTelecaller: req.user._id }, { ids, all: all === true });
    res.json({ deleted });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getLead = async (req, res) => {
  try {
    const { lead, error } = await loadOwnedLead(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const populated = await lead.populate("callLogs.calledBy", "name email");
    await populated.populate("convertedBy", "name email role");
    res.json({ lead: populated });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const CLOSED_STATUSES = ["not_interested", "wrong_number", "lost"];

// Set or clear a lead's follow-up reminder without logging a call.
exports.setFollowUp = async (req, res) => {
  try {
    const { lead, error } = await loadOwnedLead(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { followUpAt } = req.body;
    if (followUpAt === null || followUpAt === "") {
      lead.followUpAt = null;
    } else {
      const when = new Date(followUpAt);
      if (Number.isNaN(when.getTime())) {
        return res.status(400).json({ message: "Invalid follow-up date" });
      }
      lead.followUpAt = when;
    }
    await lead.save();
    res.json({ lead });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Counts for the caller's dashboard + quick-filter chips.
exports.leadSummary = async (req, res) => {
  try {
    const scope = { assignedTelecaller: req.user._id };
    const now = new Date();
    const d = (v, fallback) => {
      const t = new Date(v);
      return Number.isNaN(t.getTime()) ? fallback : t;
    };
    const dayStart = d(req.query.dayStart, new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayEnd = d(req.query.dayEnd, new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1));
    const open = { $nin: ["converted", ...CLOSED_STATUSES] };

    const [byStatus, overdue, today, invalidIds] = await Promise.all([
      Lead.aggregate([{ $match: scope }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      Lead.countDocuments({ ...scope, status: open, followUpAt: { $lt: now } }),
      Lead.countDocuments({ ...scope, status: open, followUpAt: { $gte: dayStart, $lte: dayEnd } }),
      invalidLeadIds(scope),
    ]);

    const counts = Object.fromEntries(byStatus.map((r) => [r._id, r.count]));
    res.json({
      total: byStatus.reduce((n, r) => n + r.count, 0),
      byStatus: counts,
      overdue,
      today,
      invalidCount: invalidIds.length,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.logCall = async (req, res) => {
  try {
    const { lead, error } = await loadOwnedLead(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    if (lead.convertedStudent) {
      return res.status(400).json({ message: "This lead has already been converted" });
    }

    const { response, notes, followUpAt } = req.body;
    if (!CALL_RESPONSES.includes(response)) {
      return res.status(400).json({ message: "Invalid response value" });
    }

    lead.callLogs.push({ calledBy: req.user._id, response, notes });
    // The call outcome IS the lead's new status — one shared list.
    lead.status = response;

    // Closed-out outcomes drop any reminder; open ones may set a new one.
    if (CLOSED_STATUSES.includes(response)) {
      lead.followUpAt = null;
    } else if (followUpAt) {
      const when = new Date(followUpAt);
      if (Number.isNaN(when.getTime())) {
        return res.status(400).json({ message: "Invalid follow-up date" });
      }
      lead.followUpAt = when;
    }

    await lead.save();
    const populated = await lead.populate("callLogs.calledBy", "name email");
    res.status(201).json({ lead: populated });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.registerLead = async (req, res) => {
  try {
    const { lead, error } = await loadOwnedLead(req);
    if (error) return res.status(error[0]).json({ message: error[1] });
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
      admin: lead.admin,
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
        admin: lead.admin,
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
    const { lead, error } = await loadOwnedLead(req);
    if (error) return res.status(error[0]).json({ message: error[1] });
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
