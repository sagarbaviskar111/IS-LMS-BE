const User = require("../models/User");
const { rulesOf, lateFeeTarget } = require("../utils/feeRules");
const { paymentDeadline } = require("../utils/paymentCycle");
const { hasSchedule, syncFromSchedule } = require("../utils/installmentSchedule");

const round2 = (n) => Math.round(n * 100) / 100;
const LIST_LIMIT = 100;

// Reads and checks the rules in a request body. Returns { rules } or { error }.
const readRules = (body, current) => {
  const graceDays = body.graceDays === undefined ? current.graceDays : Number(body.graceDays);
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60) {
    return { error: "Grace days must be a whole number from 0 to 60" };
  }
  const lf = body.lateFee || {};
  const mode = lf.mode === undefined ? current.lateFee.mode : lf.mode;
  if (!["none", "flat", "daily"].includes(mode)) return { error: "Late fee must be none, flat or daily" };
  const amount = lf.amount === undefined ? current.lateFee.amount : Number(lf.amount);
  const maxAmount = lf.maxAmount === undefined ? current.lateFee.maxAmount : Number(lf.maxAmount);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(maxAmount) || maxAmount < 0) {
    return { error: "Late fee amounts can't be negative" };
  }
  if (mode !== "none" && !(amount > 0)) return { error: "Enter the late fee amount" };
  const sibling = body.siblingDiscountPercent === undefined ? current.siblingDiscountPercent : Number(body.siblingDiscountPercent);
  if (!Number.isFinite(sibling) || sibling < 0 || sibling > 100) return { error: "Sibling discount must be 0–100%" };
  return { rules: { graceDays, lateFee: { mode, amount: mode === "none" ? 0 : amount, maxAmount: mode === "none" ? 0 : maxAmount }, siblingDiscountPercent: sibling } };
};

// Who would be hit if `next` replaced `current` right now:
//  - deactivated: students whose deadline passes under the new grace days
//    but had not passed under the old ones
//  - alreadyDue: students that are due to be deactivated anyway, whatever the rule
//  - lateFee: students who would be charged a late fee, and how much in total
const previewChange = async (adminId, current, next) => {
  const now = new Date();
  const students = await User.find({
    admin: adminId,
    role: "student",
    isActive: true,
    nextDueDate: { $ne: null, $lte: now },
  }).select("name email batch balanceDue nextDueDate paymentGraceUntil installmentSchedule installmentAmount lateFee");

  const deactivated = [];
  let alreadyDue = 0;
  let feeStudents = 0;
  let feeTotal = 0;
  for (const s of students) {
    if (hasSchedule(s)) syncFromSchedule(s, now);
    if (!(s.balanceDue > 0)) continue;
    const before = paymentDeadline(s, current.graceDays);
    const after = paymentDeadline(s, next.graceDays);
    if (after <= now) {
      if (before <= now) alreadyDue += 1;
      else deactivated.push({ _id: s._id, name: s.name, email: s.email, balanceDue: s.balanceDue, dueDate: s.nextDueDate, deadline: after });
      continue;
    }
    const sameDue = s.lateFee?.forDue && s.lateFee.forDue.getTime() === s.nextDueDate.getTime();
    const owed = round2(lateFeeTarget(next, now, s.nextDueDate) - (sameDue ? s.lateFee.applied || 0 : 0));
    if (owed > 0) {
      feeStudents += 1;
      feeTotal += owed;
    }
  }
  return {
    deactivated: deactivated.slice(0, LIST_LIMIT),
    deactivatedCount: deactivated.length,
    alreadyDue,
    lateFee: { students: feeStudents, total: round2(feeTotal) },
  };
};

exports.getFeeRules = async (req, res) => {
  res.json({ rules: rulesOf(req.user) });
};

exports.previewFeeRules = async (req, res) => {
  try {
    const current = rulesOf(req.user);
    const { rules, error } = readRules(req.body || {}, current);
    if (error) return res.status(400).json({ message: error });
    res.json({ rules, preview: await previewChange(req.user._id, current, rules) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.saveFeeRules = async (req, res) => {
  try {
    const current = rulesOf(req.user);
    const { rules, error } = readRules(req.body || {}, current);
    if (error) return res.status(400).json({ message: error });

    // Stricter rules can lock students out the moment they are saved: show who, and
    // only go ahead once the admin has seen the list and confirmed.
    const preview = await previewChange(req.user._id, current, rules);
    if (preview.deactivatedCount > 0 && req.body.confirm !== true) {
      return res.status(409).json({
        message: `These ${preview.deactivatedCount} student(s) will be deactivated under the new rules. Review the list and confirm.`,
        needsConfirm: true,
        preview,
      });
    }

    await User.findByIdAndUpdate(req.user._id, { feeRules: rules });
    res.json({ rules, preview });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
