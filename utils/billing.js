const crypto = require("crypto");
const Razorpay = require("razorpay");
const User = require("../models/User");
const Plan = require("../models/Plan");
const Subscription = require("../models/Subscription");
const PlatformSettings = require("../models/PlatformSettings");

const DAY = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Starter plans created on first boot; the superadmin edits them freely.
const DEFAULT_PLANS = [
  {
    key: "starter",
    name: "Starter",
    tagline: "For a single small batch-based institute",
    priceMonthly: 799,
    priceYearly: 7990,
    studentLimit: 100,
    order: 1,
    features: [
      "Up to 100 students",
      "Fees, installments and receipts",
      "Razorpay collection into your own account",
      "Attendance and assignments",
      "Student, teacher and telecaller logins",
    ],
  },
  {
    key: "growth",
    name: "Growth",
    tagline: "Admissions, reminders and exams in one place",
    priceMonthly: 1799,
    priceYearly: 17990,
    studentLimit: 300,
    order: 2,
    isPopular: true,
    features: [
      "Up to 300 students",
      "Everything in Starter",
      "WhatsApp fee reminders",
      "Exams, results and certificates",
      "Lead tracking and inquiry forms",
    ],
  },
  {
    key: "pro",
    name: "Pro",
    tagline: "For large institutes with a calling team",
    priceMonthly: 3499,
    priceYearly: 34990,
    studentLimit: 1000,
    order: 3,
    features: [
      "Up to 1,000 students",
      "Everything in Growth",
      "Telecaller team with lead assignment",
      "Session recordings on your own storage",
      "Sub-admin roles with permissions",
      "Priority support",
    ],
  },
];

const seedDefaults = async () => {
  if ((await Plan.estimatedDocumentCount()) === 0) await Plan.insertMany(DEFAULT_PLANS);
  await PlatformSettings.get();
};

// --- Platform Razorpay (the platform's OWN account, from .env) ---
// Distinct from each institute's keys in utils/gateway.js, which collect fees.
const platformKeys = () => {
  const keyId = process.env.PLATFORM_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.PLATFORM_RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET;
  return keyId && keySecret ? { keyId, keySecret } : null;
};
const platformClient = () => {
  const k = platformKeys();
  return k ? new Razorpay({ key_id: k.keyId, key_secret: k.keySecret }) : null;
};
// gateway = real Razorpay; dev = simulated (development machine, no keys); none = unavailable
const platformMode = () => (platformKeys() ? "gateway" : process.env.NODE_ENV === "development" ? "dev" : "none");

// --- Usage and access ---
const countStudents = (adminId) => User.countDocuments({ admin: adminId, role: "student" });

const planLimit = (sub, plan, settings) => {
  if (sub.studentLimitOverride !== null && sub.studentLimitOverride !== undefined) return sub.studentLimitOverride;
  if (sub.status === "trial") return settings.trialStudentLimit;
  if (settings.pricingMode === "per_student") return 0;
  return plan ? plan.studentLimit : 0;
};

// Where an institute stands: state is legacy | trial | active | expired.
const getAccess = async (adminId) => {
  const sub = await Subscription.findOne({ admin: adminId }).populate("plan");
  const settings = await PlatformSettings.get();
  const used = await countStudents(adminId);
  if (!sub) return { state: "legacy", sub: null, plan: null, limit: 0, used, canAddStudents: true, settings };

  const now = Date.now();
  let state = sub.status === "trial" ? "trial" : "active";
  const end = sub.status === "trial" ? sub.trialEndsAt : sub.currentPeriodEnd;
  if (sub.status === "cancelled" || (end && end.getTime() < now)) state = "expired";
  const limit = planLimit(sub, sub.plan, settings);
  const daysLeft = end ? Math.ceil((end.getTime() - now) / DAY) : null;

  let canAddStudents = true;
  let reason = null;
  if (settings.enforceLimits) {
    if (state === "expired") {
      canAddStudents = false;
      reason = "This institute's subscription has ended. Renew the plan to add new students.";
    } else if (limit > 0 && used >= limit) {
      canAddStudents = false;
      reason = `Student limit reached (${limit}). Upgrade the plan to add more students.`;
    }
  }
  return { state, sub, plan: sub.plan, limit, used, daysLeft, end, canAddStudents, reason, settings };
};

// Returns an error message when this institute may not add another student.
const studentCapacityError = async (adminId) => {
  if (!adminId) return null;
  const a = await getAccess(adminId);
  return a.canAddStudents ? null : a.reason;
};

// --- Pricing --- decided on the server; the client only picks plan/interval.
const quote = async ({ adminId, plan, interval }) => {
  const settings = await PlatformSettings.get();
  const sub = await Subscription.findOne({ admin: adminId });
  const students = await countStudents(adminId);
  let base;
  let billed = 0;
  if (sub && sub.customPrice !== null && sub.customPrice !== undefined) {
    base = sub.customPrice;
  } else if (settings.pricingMode === "per_student") {
    billed = Math.max(students, settings.perStudentMin);
    const monthly = billed * settings.perStudentPrice;
    base = interval === "yearly" ? monthly * 12 * (1 - settings.yearlyDiscountPercent / 100) : monthly;
  } else {
    base = interval === "yearly" ? plan.priceYearly : plan.priceMonthly;
  }
  base = round2(base);
  const gst = round2((base * settings.gstPercent) / 100);
  return {
    base,
    gst,
    total: round2(base + gst),
    gstPercent: settings.gstPercent,
    students: billed,
    pricingMode: settings.pricingMode,
  };
};

const addPeriod = (from, interval) => {
  const d = new Date(from);
  if (interval === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
};

// Marks a paid period on the subscription. A renewal before expiry stacks on the
// remaining time instead of wasting it.
const activate = async (adminId, planId, interval, when = new Date()) => {
  let sub = await Subscription.findOne({ admin: adminId });
  if (!sub) sub = new Subscription({ admin: adminId });
  const stillRunning = sub.status === "active" && sub.currentPeriodEnd && sub.currentPeriodEnd > when;
  const periodStart = stillRunning ? sub.currentPeriodEnd : when;
  const periodEnd = addPeriod(periodStart, interval);
  sub.plan = planId;
  sub.interval = interval;
  sub.status = "active";
  sub.currentPeriodEnd = periodEnd;
  await sub.save();
  return { periodStart, periodEnd };
};

const startTrial = async (adminId, planId) => {
  const settings = await PlatformSettings.get();
  return Subscription.create({
    admin: adminId,
    plan: planId,
    status: "trial",
    trialEndsAt: new Date(Date.now() + settings.trialDays * DAY),
  });
};

const signatureOk = (orderId, paymentId, signature) => {
  const k = platformKeys();
  if (!k) return false;
  const expected = crypto.createHmac("sha256", k.keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  const given = String(signature || "");
  return expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
};

module.exports = {
  seedDefaults,
  platformKeys,
  platformClient,
  platformMode,
  getAccess,
  studentCapacityError,
  countStudents,
  quote,
  activate,
  startTrial,
  signatureOk,
  addPeriod,
  DAY,
  round2,
};
