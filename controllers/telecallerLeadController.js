const Lead = require("../models/Lead");
const User = require("../models/User");
const Payment = require("../models/Payment");
const { CALL_RESPONSES } = require("../models/Lead");
const crypto = require("crypto");
const paginate = require("../utils/paginate");
const { DAY_MS } = require("../utils/paymentCycle");

const loadOwnedLead = async (req) => {
  const lead = await Lead.findOne({ _id: req.params.id, assignedTelecaller: req.user._id });
  if (!lead) return { error: [404, "Lead not found"] };
  return { lead };
};

exports.listMyLeads = async (req, res) => {
  try {
    const filter = { assignedTelecaller: req.user._id };
    const { page, limit, skip } = paginate(req);

    const [leads, total] = await Promise.all([
      Lead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Lead.countDocuments(filter),
    ]);

    res.json({ leads, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
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

exports.logCall = async (req, res) => {
  try {
    const { lead, error } = await loadOwnedLead(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { response, notes } = req.body;
    if (!CALL_RESPONSES.includes(response)) {
      return res.status(400).json({ message: "Invalid response value" });
    }

    lead.callLogs.push({ calledBy: req.user._id, response, notes });
    if (response === "interested") lead.status = "interested";
    else if (response === "not_interested") lead.status = "not_interested";
    else if (lead.status === "new") lead.status = "contacted";

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
