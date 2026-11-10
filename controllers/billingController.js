const mongoose = require("mongoose");
const User = require("../models/User");
const Plan = require("../models/Plan");
const Subscription = require("../models/Subscription");
const BillingPayment = require("../models/BillingPayment");
const PlatformSettings = require("../models/PlatformSettings");
const generateToken = require("../utils/generateToken");
const { sessionUser } = require("../utils/sessionUser");
const { resolveInstitute } = require("../utils/institute");
const { generateUniqueSlug } = require("../utils/slug");
const { generateTenantInviteCodes } = require("./userController");
const billing = require("../utils/billing");

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  domain: process.env.COOKIE_DOMAIN || undefined,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const fail = (res, code, message) => res.status(code).json({ message });
const server = (res, err) => {
  console.error("[billing]", err);
  return fail(res, 500, "Server error");
};

const shapePlan = (p) => ({
  _id: p._id,
  key: p.key,
  name: p.name,
  tagline: p.tagline,
  priceMonthly: p.priceMonthly,
  priceYearly: p.priceYearly,
  studentLimit: p.studentLimit,
  features: p.features,
  isPopular: p.isPopular,
  isActive: p.isActive,
  order: p.order,
});

const shapeSettings = (s) => ({
  pricingMode: s.pricingMode,
  perStudentPrice: s.perStudentPrice,
  perStudentMin: s.perStudentMin,
  yearlyDiscountPercent: s.yearlyDiscountPercent,
  trialDays: s.trialDays,
  trialStudentLimit: s.trialStudentLimit,
  gstPercent: s.gstPercent,
  enforceLimits: s.enforceLimits,
  signupOpen: s.signupOpen,
});

const shapeAccess = (a) => ({
  state: a.state,
  plan: a.plan ? shapePlan(a.plan) : null,
  interval: a.sub?.interval || null,
  status: a.sub?.status || null,
  end: a.end || null,
  daysLeft: a.daysLeft ?? null,
  used: a.used,
  limit: a.limit,
  canAddStudents: a.canAddStudents,
  reason: a.reason || null,
  customPrice: a.sub?.customPrice ?? null,
});

// ---------------- Public ----------------

exports.publicPlans = async (req, res) => {
  try {
    const [plans, settings] = await Promise.all([
      Plan.find({ isActive: true }).sort({ order: 1, priceMonthly: 1 }),
      PlatformSettings.get(),
    ]);
    res.json({ plans: plans.map(shapePlan), settings: shapeSettings(settings) });
  } catch (err) {
    server(res, err);
  }
};

// Self-serve institute signup: creates the admin account, a unique /slug,
// the invite codes, and a trial subscription. No payment needed to start.
exports.signup = async (req, res) => {
  try {
    const settings = await PlatformSettings.get();
    if (!settings.signupOpen) return fail(res, 403, "New institute signups are closed right now.");

    const instituteName = String(req.body.instituteName || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const phone = String(req.body.phone || "").trim();
    if (instituteName.length < 3 || instituteName.length > 80) return fail(res, 400, "Enter your institute name (3-80 characters)");
    if (!EMAIL_RE.test(email)) return fail(res, 400, "Enter a valid email address");
    if (password.length < 6) return fail(res, 400, "Password must be at least 6 characters");
    if (!/^[0-9+\-\s]{10,15}$/.test(phone)) return fail(res, 400, "Enter a valid phone number");

    if (await User.findOne({ email })) return fail(res, 409, "An account with this email already exists - log in instead");

    let plan = null;
    if (req.body.planId && isId(req.body.planId)) plan = await Plan.findOne({ _id: req.body.planId, isActive: true });
    if (!plan) plan = await Plan.findOne({ isActive: true, isPopular: true }).sort({ order: 1 });
    if (!plan) plan = await Plan.findOne({ isActive: true }).sort({ order: 1 });

    const codes = await generateTenantInviteCodes();
    const admin = await User.create({
      name: instituteName,
      email,
      password,
      phone,
      role: "admin",
      isActive: true,
      instituteSlug: await generateUniqueSlug(instituteName),
      ...codes,
    });
    await billing.startTrial(admin._id, plan?._id || null);

    const institute = await resolveInstitute(admin);
    res.cookie("token", generateToken(admin, institute?.slug), cookieOptions);
    res.status(201).json({ user: await sessionUser(admin), institute });
  } catch (err) {
    server(res, err);
  }
};

// ---------------- Institute admin ----------------

exports.myBilling = async (req, res) => {
  try {
    const [access, plans, payments] = await Promise.all([
      billing.getAccess(req.user._id),
      Plan.find({ isActive: true }).sort({ order: 1, priceMonthly: 1 }),
      BillingPayment.find({ admin: req.user._id, status: "paid" }).sort({ paidAt: -1 }).limit(24),
    ]);
    res.json({
      access: shapeAccess(access),
      settings: shapeSettings(access.settings),
      plans: plans.map(shapePlan),
      mode: billing.platformMode(),
      payments: payments.map((p) => ({
        _id: p._id,
        planName: p.planName,
        interval: p.interval,
        base: p.base,
        gst: p.gst,
        total: p.total,
        paidAt: p.paidAt,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        mode: p.mode,
      })),
    });
  } catch (err) {
    server(res, err);
  }
};

const readCheckout = async (req) => {
  const interval = req.body.interval === "yearly" ? "yearly" : "monthly";
  const settings = await PlatformSettings.get();
  let plan = null;
  if (req.body.planId && isId(req.body.planId)) plan = await Plan.findById(req.body.planId);
  if (!plan) return { error: "Choose a plan" };
  const sub = await Subscription.findOne({ admin: req.user._id });
  const ownsIt = sub && String(sub.plan) === String(plan._id);
  if (!plan.isActive && !ownsIt) return { error: "This plan is no longer available" };
  if (settings.pricingMode === "plan" && plan.priceMonthly <= 0) return { error: "This plan is free - nothing to pay" };
  return { plan, interval };
};

exports.createOrder = async (req, res) => {
  try {
    const mode = billing.platformMode();
    if (mode === "none") return fail(res, 503, "Online billing isn't available right now. Please contact support.");
    const { plan, interval, error } = await readCheckout(req);
    if (error) return fail(res, 400, error);

    const q = await billing.quote({ adminId: req.user._id, plan, interval });
    if (q.total <= 0) return fail(res, 400, "Nothing to pay for this selection");

    const doc = {
      admin: req.user._id,
      plan: plan._id,
      planName: plan.name,
      interval,
      pricingMode: q.pricingMode,
      students: q.students,
      base: q.base,
      gst: q.gst,
      total: q.total,
      mode,
    };

    if (mode === "dev") {
      const row = await BillingPayment.create({ ...doc, razorpayOrderId: `dev_order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` });
      return res.json({ mode, orderId: row.razorpayOrderId, amount: Math.round(q.total * 100), total: q.total });
    }

    const keys = billing.platformKeys();
    const order = await billing.platformClient().orders.create({
      amount: Math.round(q.total * 100),
      currency: "INR",
      receipt: `sub_${String(req.user._id).slice(-8)}_${Date.now()}`.slice(0, 40),
      notes: { purpose: "subscription", admin: String(req.user._id), plan: String(plan._id), interval },
    });
    await BillingPayment.create({ ...doc, razorpayOrderId: order.id });
    res.json({ mode, orderId: order.id, amount: order.amount, currency: order.currency, keyId: keys.keyId, total: q.total, name: req.user.name, email: req.user.email });
  } catch (err) {
    server(res, err);
  }
};

exports.verifyOrder = async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;
    if (!orderId) return fail(res, 400, "Payment details are missing");
    const row = await BillingPayment.findOne({ razorpayOrderId: orderId, admin: req.user._id });
    if (!row) return fail(res, 404, "Order not found");
    if (row.status === "paid") return res.json({ ok: true, access: shapeAccess(await billing.getAccess(req.user._id)) });

    if (row.mode === "dev") {
      if (process.env.NODE_ENV !== "development" || billing.platformKeys()) return fail(res, 400, "Invalid payment");
      row.razorpayPaymentId = `dev_pay_${Date.now()}`;
    } else {
      if (!paymentId || !signature) return fail(res, 400, "Payment details are missing");
      if (!billing.signatureOk(orderId, paymentId, signature)) return fail(res, 400, "Payment verification failed");
      if (await BillingPayment.exists({ razorpayPaymentId: paymentId })) return fail(res, 400, "This payment has already been used");
      try {
        const client = billing.platformClient();
        let payment = await client.payments.fetch(paymentId);
        if (payment.order_id !== orderId || payment.amount !== Math.round(row.total * 100)) return fail(res, 400, "Payment verification failed");
        if (payment.status === "authorized") payment = await client.payments.capture(paymentId, payment.amount, "INR");
        if (payment.status !== "captured") return fail(res, 400, "Your payment has not been completed");
      } catch {
        return fail(res, 502, "Could not confirm the payment with Razorpay. If money was deducted it will be refunded.");
      }
      row.razorpayPaymentId = paymentId;
    }

    const { periodStart, periodEnd } = await billing.activate(row.admin, row.plan, row.interval);
    row.status = "paid";
    row.paidAt = new Date();
    row.periodStart = periodStart;
    row.periodEnd = periodEnd;
    await row.save();
    res.json({ ok: true, access: shapeAccess(await billing.getAccess(req.user._id)) });
  } catch (err) {
    server(res, err);
  }
};

// Price preview for the upgrade screen (so the client never computes money).
exports.previewQuote = async (req, res) => {
  try {
    const { plan, interval, error } = await readCheckout(req);
    if (error) return fail(res, 400, error);
    res.json({ quote: await billing.quote({ adminId: req.user._id, plan, interval }) });
  } catch (err) {
    server(res, err);
  }
};

// ---------------- Superadmin ----------------

exports.getSettings = async (req, res) => {
  try {
    const s = await PlatformSettings.get();
    res.json({ settings: shapeSettings(s), razorpay: { mode: billing.platformMode(), configured: !!billing.platformKeys() } });
  } catch (err) {
    server(res, err);
  }
};

const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

exports.updateSettings = async (req, res) => {
  try {
    const b = req.body;
    const s = await PlatformSettings.get();
    if (b.pricingMode !== undefined) {
      if (!["plan", "per_student"].includes(b.pricingMode)) return fail(res, 400, "Invalid pricing mode");
      s.pricingMode = b.pricingMode;
    }
    const fields = {
      perStudentPrice: [0, 100000],
      perStudentMin: [0, 100000],
      yearlyDiscountPercent: [0, 90],
      trialDays: [0, 365],
      trialStudentLimit: [0, 1000000],
      gstPercent: [0, 40],
    };
    for (const [k, [lo, hi]] of Object.entries(fields)) {
      if (b[k] === undefined) continue;
      const n = num(b[k], lo, hi);
      if (n === null) return fail(res, 400, `${k} must be between ${lo} and ${hi}`);
      s[k] = n;
    }
    for (const k of ["enforceLimits", "signupOpen"]) if (b[k] !== undefined) s[k] = !!b[k];
    await s.save();
    res.json({ settings: shapeSettings(s) });
  } catch (err) {
    server(res, err);
  }
};

exports.listPlans = async (req, res) => {
  try {
    const plans = await Plan.find({}).sort({ order: 1, priceMonthly: 1 });
    const counts = await Subscription.aggregate([{ $group: { _id: "$plan", n: { $sum: 1 } } }]);
    const by = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
    res.json({ plans: plans.map((p) => ({ ...shapePlan(p), subscribers: by[String(p._id)] || 0 })) });
  } catch (err) {
    server(res, err);
  }
};

const readPlan = (b, partial) => {
  const out = {};
  if (!partial || b.name !== undefined) {
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) return { error: "Plan name is required" };
    out.name = name;
  }
  if (b.tagline !== undefined) out.tagline = String(b.tagline).trim().slice(0, 160);
  for (const k of ["priceMonthly", "priceYearly", "studentLimit", "order"]) {
    if (b[k] === undefined) continue;
    const n = num(b[k], k === "order" ? -1000 : 0, 10000000);
    if (n === null) return { error: `${k} must be a number` };
    out[k] = n;
  }
  if (b.features !== undefined) {
    if (!Array.isArray(b.features)) return { error: "features must be a list" };
    out.features = b.features.map((f) => String(f).trim().slice(0, 120)).filter(Boolean).slice(0, 20);
  }
  for (const k of ["isPopular", "isActive"]) if (b[k] !== undefined) out[k] = !!b[k];
  return { value: out };
};

exports.createPlan = async (req, res) => {
  try {
    const { value, error } = readPlan(req.body, false);
    if (error) return fail(res, 400, error);
    const base = String(req.body.key || value.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    let key = base || "plan";
    for (let i = 2; await Plan.exists({ key }); i += 1) key = `${base}-${i}`;
    if (value.isPopular) await Plan.updateMany({}, { isPopular: false });
    const plan = await Plan.create({ ...value, key });
    res.status(201).json({ plan: shapePlan(plan) });
  } catch (err) {
    server(res, err);
  }
};

exports.updatePlan = async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 400, "Invalid plan");
    const { value, error } = readPlan(req.body, true);
    if (error) return fail(res, 400, error);
    if (value.isPopular) await Plan.updateMany({ _id: { $ne: req.params.id } }, { isPopular: false });
    const plan = await Plan.findByIdAndUpdate(req.params.id, value, { new: true });
    if (!plan) return fail(res, 404, "Plan not found");
    res.json({ plan: shapePlan(plan) });
  } catch (err) {
    server(res, err);
  }
};

exports.deletePlan = async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 400, "Invalid plan");
    if (await Subscription.exists({ plan: req.params.id })) {
      return fail(res, 409, "Institutes are on this plan. Hide it instead of deleting.");
    }
    await Plan.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    server(res, err);
  }
};

// All institutes with where they stand, plus revenue totals.
exports.listSubscriptions = async (req, res) => {
  try {
    const admins = await User.find({ role: "admin" }).select("name email phone instituteSlug createdAt isActive");
    const [subs, counts, revenue] = await Promise.all([
      Subscription.find({}).populate("plan"),
      User.aggregate([{ $match: { role: "student" } }, { $group: { _id: "$admin", n: { $sum: 1 } } }]),
      BillingPayment.aggregate([{ $match: { status: "paid" } }, { $group: { _id: "$admin", total: { $sum: "$total" }, last: { $max: "$paidAt" } } }]),
    ]);
    const subBy = new Map(subs.map((s) => [String(s.admin), s]));
    const cnt = new Map(counts.map((c) => [String(c._id), c.n]));
    const rev = new Map(revenue.map((r) => [String(r._id), r]));
    const now = Date.now();

    const rows = admins.map((a) => {
      const s = subBy.get(String(a._id));
      let state = "legacy";
      let end = null;
      if (s) {
        end = s.status === "trial" ? s.trialEndsAt : s.currentPeriodEnd;
        state = s.status === "cancelled" || (end && end.getTime() < now) ? "expired" : s.status;
      }
      return {
        adminId: a._id,
        name: a.name,
        email: a.email,
        phone: a.phone || "",
        slug: a.instituteSlug,
        joined: a.createdAt,
        state,
        planId: s?.plan?._id || null,
        planName: s?.plan?.name || null,
        interval: s?.interval || null,
        end,
        students: cnt.get(String(a._id)) || 0,
        limit: s ? (s.studentLimitOverride ?? (s.status === "trial" ? null : s.plan?.studentLimit ?? 0)) : null,
        customPrice: s?.customPrice ?? null,
        studentLimitOverride: s?.studentLimitOverride ?? null,
        note: s?.note || "",
        paidTotal: rev.get(String(a._id))?.total || 0,
        lastPaidAt: rev.get(String(a._id))?.last || null,
      };
    });

    const paidRows = await BillingPayment.find({ status: "paid" }).sort({ paidAt: -1 }).limit(15).populate("admin", "name");
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const sum = (list) => list.reduce((t, r) => t + (r.paidTotal || 0), 0);
    const monthAgg = await BillingPayment.aggregate([{ $match: { status: "paid", paidAt: { $gte: monthStart } } }, { $group: { _id: null, t: { $sum: "$total" } } }]);

    res.json({
      summary: {
        institutes: rows.length,
        trial: rows.filter((r) => r.state === "trial").length,
        active: rows.filter((r) => r.state === "active").length,
        expired: rows.filter((r) => r.state === "expired").length,
        legacy: rows.filter((r) => r.state === "legacy").length,
        revenueTotal: sum(rows),
        revenueThisMonth: monthAgg[0]?.t || 0,
      },
      institutes: rows.sort((x, y) => new Date(y.joined) - new Date(x.joined)),
      recentPayments: paidRows.map((p) => ({ _id: p._id, institute: p.admin?.name || "-", planName: p.planName, interval: p.interval, total: p.total, paidAt: p.paidAt, mode: p.mode })),
    });
  } catch (err) {
    server(res, err);
  }
};

// Manual control over one institute: change plan, extend or end, special price/limit.
exports.updateSubscription = async (req, res) => {
  try {
    if (!isId(req.params.adminId)) return fail(res, 400, "Invalid institute");
    const admin = await User.findOne({ _id: req.params.adminId, role: "admin" });
    if (!admin) return fail(res, 404, "Institute not found");
    const b = req.body;

    let sub = await Subscription.findOne({ admin: admin._id });
    if (!sub) sub = new Subscription({ admin: admin._id, status: "active", currentPeriodEnd: new Date() });

    if (b.planId !== undefined) {
      if (b.planId === null || b.planId === "") sub.plan = null;
      else {
        if (!isId(b.planId) || !(await Plan.exists({ _id: b.planId }))) return fail(res, 400, "Plan not found");
        sub.plan = b.planId;
      }
    }
    if (b.interval !== undefined && ["monthly", "yearly"].includes(b.interval)) sub.interval = b.interval;
    if (b.status !== undefined) {
      if (!["trial", "active", "cancelled"].includes(b.status)) return fail(res, 400, "Invalid status");
      sub.status = b.status;
    }
    if (b.extendDays !== undefined) {
      const d = num(b.extendDays, -3650, 3650);
      if (d === null) return fail(res, 400, "extendDays must be a number");
      const field = sub.status === "trial" ? "trialEndsAt" : "currentPeriodEnd";
      const from = sub[field] && sub[field].getTime() > Date.now() ? sub[field].getTime() : Date.now();
      sub[field] = new Date(from + d * billing.DAY);
      if (sub.status === "cancelled") sub.status = "active";
    }
    for (const k of ["customPrice", "studentLimitOverride"]) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === "") sub[k] = null;
      else {
        const n = num(b[k], 0, 100000000);
        if (n === null) return fail(res, 400, `${k} must be a number`);
        sub[k] = n;
      }
    }
    if (b.note !== undefined) sub.note = String(b.note).slice(0, 300);
    await sub.save();
    res.json({ ok: true });
  } catch (err) {
    server(res, err);
  }
};
