const User = require("../models/User");

const DEFAULT_GRACE_DAYS = 3;
const round2 = (n) => Math.round(n * 100) / 100;

// An institute's fee rules with every missing value filled in.
const rulesOf = (admin) => {
  const r = admin?.feeRules || {};
  const mode = ["flat", "daily"].includes(r.lateFee?.mode) ? r.lateFee.mode : "none";
  return {
    graceDays: Number.isFinite(r.graceDays) ? r.graceDays : DEFAULT_GRACE_DAYS,
    lateFee: { mode, amount: r.lateFee?.amount || 0, maxAmount: r.lateFee?.maxAmount || 0 },
    siblingDiscountPercent: r.siblingDiscountPercent || 0,
  };
};

const getFeeRules = async (adminId) => rulesOf(adminId ? await User.findById(adminId).select("feeRules") : null);

// What a late fee should add up to right now for a due date that is `daysLate` days behind.
const lateFeeTarget = (rules, now, dueDate) => {
  const { mode, amount, maxAmount } = rules.lateFee;
  if (mode === "none" || !(amount > 0) || !dueDate || dueDate > now) return 0;
  const days = Math.floor((now - dueDate) / (24 * 60 * 60 * 1000));
  const raw = mode === "flat" ? amount : amount * days;
  return round2(maxAmount > 0 ? Math.min(raw, maxAmount) : raw);
};

module.exports = { DEFAULT_GRACE_DAYS, rulesOf, getFeeRules, lateFeeTarget };
