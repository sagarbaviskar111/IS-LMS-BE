const crypto = require("crypto");
const mongoose = require("mongoose");
const PaymentOrder = require("../models/PaymentOrder");
const Payment = require("../models/Payment");
const User = require("../models/User");
const Batch = require("../models/Batch");
const { NO_GATEWAY_MESSAGE, getGateway, paymentMode, createOrder, verifyPayment, fetchCapturedPayment } = require("./gateway");
const { hasSchedule, applyPayment, applyToItem, isCaughtUp, remainingOf, totalRemaining } = require("./installmentSchedule");
const { getFeeStatus, closeOutIfFullyPaid } = require("./feeStatus");
const { notifyUsers } = require("./notify");

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

// Errors that carry the HTTP status to answer with.
const fail = (status, message) => Object.assign(new Error(message), { status });
const respondError = (res, err, fallback = "Server error") =>
  err && err.status ? res.status(err.status).json({ message: err.message }) : res.status(500).json({ message: fallback });

const receiptNo = (payment) => `RCPT-${String(payment._id).slice(-8).toUpperCase()}`;
const publicPayment = (payment) => ({
  _id: payment._id,
  amount: payment.amount,
  receiptNo: receiptNo(payment),
  createdAt: payment.createdAt,
});

// ---- what a student can pay right now (always worked out on the server) ----

// Days the next due date moves out when an installment is paid early.
const cycleDaysOf = async (student) => {
  const batch = student.batch ? await Batch.findById(student.batch).select("paymentCycleDays") : null;
  return batch?.paymentCycleDays || 30;
};

const duesQuote = (student) => (student.balanceDue > 0 ? { amount: round2(student.balanceDue) } : { error: "You have no dues to pay" });

const nextInstallmentQuote = async (student) => {
  if (hasSchedule(student)) return { error: "Your installments follow a fixed schedule — pay the current one above" };
  if (!(student.installmentAmount > 0) || !student.nextDueDate) return { error: "You have no upcoming installment" };
  if (student.balanceDue > 0) return { error: "Clear your current balance due first" };
  // Never take more than what's left of the course fee.
  const feeStatus = await getFeeStatus(student);
  if (feeStatus && feeStatus.remaining <= 0) return { error: "Your course fees are already fully paid" };
  const amount = feeStatus ? Math.min(student.installmentAmount, feeStatus.remaining) : student.installmentAmount;
  return { amount: round2(amount) };
};

// A part payment: the student picks an amount, and optionally which installment it is for.
const customQuote = (student, { amount, itemId } = {}) => {
  const amt = round2(Number(amount));
  if (!Number.isFinite(amt) || amt < 1) return { error: "Enter an amount of at least ₹1" };
  if (hasSchedule(student)) {
    if (itemId) {
      const item = student.installmentSchedule.id(itemId);
      if (!item) return { error: "That installment was not found" };
      const left = remainingOf(item);
      if (!(left > 0)) return { error: "That installment is already paid" };
      if (amt > left + 0.005) return { error: `That installment needs at most ₹${left}` };
      return { amount: amt, itemId: String(item._id) };
    }
    const total = totalRemaining(student);
    if (!(total > 0)) return { error: "You have no fees left to pay" };
    if (amt > total + 0.005) return { error: `You only owe ₹${total} in total` };
    return { amount: amt };
  }
  if (!(student.balanceDue > 0)) return { error: "You have no dues right now. To pay ahead, use the next installment option." };
  if (amt > student.balanceDue + 0.005) return { error: `You owe ₹${round2(student.balanceDue)} right now` };
  return { amount: amt };
};

const quoteFor = async (student, purpose, opts) =>
  purpose === "dues" ? duesQuote(student) : purpose === "custom" ? customQuote(student, opts) : nextInstallmentQuote(student);

// ---- opening an order -------------------------------------------------------

// Step one for dues / next-installment payments. Returns what the browser needs
// to open Razorpay, or { mode: "dev" } on a development machine without keys.
const openStudentOrder = async (student, purpose, opts) => {
  const quote = await quoteFor(student, purpose, opts);
  if (quote.error) throw fail(400, quote.error);

  const pm = await paymentMode(student.admin);
  if (pm.mode === "none") throw fail(400, NO_GATEWAY_MESSAGE);
  if (pm.mode === "dev") return { mode: "dev", amount: quote.amount };
  const itemNote = quote.itemId ? { itemId: quote.itemId } : {};

  const order = await createOrder(pm.gateway, {
    amount: quote.amount,
    receipt: `${purpose === "dues" ? "dues" : purpose === "custom" ? "part" : "next"}_${student._id}`,
    notes: { purpose, studentId: String(student._id), ...itemNote },
  });
  await PaymentOrder.create({
    admin: student.admin,
    student: student._id,
    purpose,
    amount: quote.amount,
    razorpayOrderId: order.orderId,
    meta: { itemId: quote.itemId || null },
  });
  return { mode: "gateway", ...order, name: student.name, email: student.email };
};

// ---- recording a paid order -------------------------------------------------

// Blocked only for unpaid fees and now caught up: open the account again.
const reopenIfCaughtUp = (student) => {
  if (student.deactivatedForPayment && isCaughtUp(student)) {
    student.isActive = true;
    student.deactivatedForPayment = false;
    student.deactivationMessage = null;
  }
};

// A part payment, on the installment the student chose or spread from the earliest.
const applyCustom = (student, amount, itemId) => {
  const item = itemId && hasSchedule(student) ? student.installmentSchedule.id(itemId) : null;
  if (!item) return applyDues(student, amount);
  const left = applyToItem(student, item, amount);
  reopenIfCaughtUp(student);
  return left;
};

const applyDues = (student, amount) => {
  let left;
  if (hasSchedule(student)) {
    // Settles the installments that are due; the next one then becomes current.
    left = applyPayment(student, amount);
  } else {
    const before = student.balanceDue;
    student.balanceDue = Math.max(0, round2(before - amount));
    left = Math.max(0, round2(amount - before));
    if (!(student.balanceDue > 0)) student.paymentGraceUntil = null;
  }
  reopenIfCaughtUp(student);
  return left;
};

const applyNext = (student, amount, cycleDays) => {
  student.nextDueDate = new Date(student.nextDueDate.getTime() + cycleDays * DAY_MS);
  student.paymentGraceUntil = null;
  student.lastFeeReminderAt = null;
  return 0;
};

// Records a paid dues / next-installment order: the student's balance or due
// date, the Payment row and the order's own state change together in ONE
// transaction, so a crash can never leave money taken but not recorded (or
// recorded twice). Safe to call again for the same order.
const fulfilStudentOrder = async (order) => {
  const initial = await PaymentOrder.findById(order._id);
  if (!initial) throw fail(404, "Payment not found");
  const cycleDays = initial.purpose === "next_installment" ? await cycleDaysOf(await User.findById(initial.student)) : 0;

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const fresh = await PaymentOrder.findById(order._id).session(session);
      if (fresh.status === "fulfilled") {
        result = { order: fresh, payment: await Payment.findById(fresh.payment).session(session) };
        return;
      }
      const student = await User.findById(fresh.student).session(session);
      const left =
        fresh.purpose === "dues"
          ? applyDues(student, fresh.amount)
          : fresh.purpose === "custom"
          ? applyCustom(student, fresh.amount, fresh.meta?.itemId)
          : applyNext(student, fresh.amount, cycleDays);
      await student.save({ session });

      const gateway = fresh.mode === "gateway";
      const [payment] = await Payment.create(
        [
          {
            student: student._id,
            admin: student.admin,
            batch: student.batch || null,
            amount: fresh.amount,
            method: gateway ? "razorpay" : "online",
            status: "paid",
            note: fresh.purpose === "dues" ? "Online payment" : fresh.purpose === "custom" ? "Online part payment" : "Next installment paid in advance",
            ...(gateway ? { razorpayOrderId: fresh.razorpayOrderId, razorpayPaymentId: fresh.razorpayPaymentId } : {}),
          },
        ],
        { session }
      );
      fresh.status = "fulfilled";
      fresh.fulfilledAt = new Date();
      fresh.payment = payment._id;
      fresh.excess = left;
      await fresh.save({ session });
      result = { order: fresh, payment };
    });
  } finally {
    await session.endSession();
  }

  // Once the whole course fee is in, the fee cycle stops for good.
  const student = await User.findById(result.order.student);
  if (student) await closeOutIfFullyPaid(student);
  await announce(result.order, result.payment, student);
  return result;
};

const announce = async (order, payment, student) => {
  if (!student) return;
  const text = `₹${payment.amount} received online (receipt ${receiptNo(payment)}).`;
  await notifyUsers({ _id: student.admin, role: "admin" }, [student._id], "Payment received", `Your payment of ${text}`);
  await notifyUsers(student, [student.admin], "Fee payment received", `${student.name} paid ${text}`);
};

// ---- the browser says "paid": check it and record it ------------------------

// proof = { orderId, paymentId, signature } from Razorpay checkout (absent in dev mode).
const payStudentOrder = async (student, purpose, proof, opts) => {
  const pm = await paymentMode(student.admin);
  if (pm.mode === "none") throw fail(400, NO_GATEWAY_MESSAGE);

  if (pm.mode === "dev") {
    const quote = await quoteFor(student, purpose, opts);
    if (quote.error) throw fail(400, quote.error);
    const order = await PaymentOrder.create({
      admin: student.admin,
      student: student._id,
      purpose,
      amount: quote.amount,
      mode: "dev",
      meta: { itemId: quote.itemId || null },
      razorpayOrderId: `dev_${crypto.randomBytes(8).toString("hex")}`,
      status: "paid",
      paidAt: new Date(),
    });
    return fulfilStudentOrder(order);
  }

  if (!proof?.orderId) throw fail(400, "Payment details are missing — please try again");
  let order = await PaymentOrder.findOne({ razorpayOrderId: proof.orderId, student: student._id, purpose, admin: student.admin });
  if (!order) throw fail(400, "Payment verification failed");

  if (order.status === "created") {
    const problem = await verifyPayment(pm.gateway, {
      orderId: order.razorpayOrderId,
      paymentId: proof.paymentId,
      signature: proof.signature,
      amount: order.amount,
      notes: { purpose, studentId: String(student._id), ...(order.meta?.itemId ? { itemId: order.meta.itemId } : {}) },
    });
    if (problem) {
      // The background check may have recorded this very payment a moment ago.
      const again = await PaymentOrder.findById(order._id);
      if (again.status !== "fulfilled") throw fail(400, problem);
      order = again;
    } else {
      order =
        (await PaymentOrder.findOneAndUpdate(
          { _id: order._id, status: "created" },
          { $set: { status: "paid", razorpayPaymentId: proof.paymentId, paidAt: new Date() } },
          { returnDocument: "after" }
        )) || (await PaymentOrder.findById(order._id));
    }
  }
  return fulfilStudentOrder(order);
};

// The browser may report a payment that the background check already recorded.
// That is a success, not an error.
const alreadyRecorded = async (student, purpose, orderId) => {
  if (!orderId) return null;
  const order = await PaymentOrder.findOne({ razorpayOrderId: orderId, student: student._id, purpose, status: "fulfilled" });
  if (!order) return null;
  return { order, payment: await Payment.findById(order.payment) };
};

// ---- course registration (paid before the account exists) -------------------

const registrationQuery = ({ course, token, plan }) => ({
  admin: course.admin,
  purpose: "course_registration",
  "meta.token": String(token),
  "meta.plan": String(plan),
});

// A payment made earlier for this same registration that never got used (the
// submit failed after the student paid): reuse it instead of charging twice.
const findUnusedRegistrationPayment = async ({ course, token, plan, email, amount }) => {
  const order = await PaymentOrder.findOne({
    ...registrationQuery({ course, token, plan }),
    status: "paid",
    ...(email ? { "meta.email": email } : {}),
  }).sort({ paidAt: -1 });
  return order && round2(order.amount) === round2(amount) ? order : null;
};

const openRegistrationOrder = async ({ course, token, plan, email, amount, name }) => {
  const pm = await paymentMode(course.admin);
  if (pm.mode === "none") throw fail(400, NO_GATEWAY_MESSAGE);
  if (pm.mode === "dev") return { mode: "dev", amount };

  const unused = await findUnusedRegistrationPayment({ course, token, plan, email, amount });
  if (unused) return { mode: "paid", orderId: unused.razorpayOrderId, amount };

  const order = await createOrder(pm.gateway, {
    amount,
    receipt: `reg_${course._id}`,
    notes: { purpose: "course_registration", courseId: String(course._id), token: String(token), plan: String(plan) },
  });
  await PaymentOrder.create({
    admin: course.admin,
    purpose: "course_registration",
    amount,
    razorpayOrderId: order.orderId,
    meta: { courseId: String(course._id), token: String(token), plan: String(plan), email: email || null },
  });
  return { mode: "gateway", ...order, name };
};

// At submit: the order the student paid, verified and ready to attach to the
// new account. Returns { order } or { error }.
const claimRegistrationOrder = async ({ course, token, plan, email, amount, proof }) => {
  const pm = await paymentMode(course.admin);
  if (pm.mode !== "gateway") return { error: NO_GATEWAY_MESSAGE };
  if (!proof?.orderId) return { error: "Payment details are missing — please try again" };

  let order = await PaymentOrder.findOne({ razorpayOrderId: proof.orderId, ...registrationQuery({ course, token, plan }) });
  if (!order) return { error: "Payment verification failed" };
  if (order.status === "fulfilled") return { error: "This payment was already used for a registration" };
  if (round2(order.amount) !== round2(amount)) return { error: "Payment amount does not match" };
  if (order.meta?.email && email && order.meta.email !== email) return { error: "This payment was made with a different email" };

  if (order.status === "created") {
    const problem = await verifyPayment(pm.gateway, {
      orderId: order.razorpayOrderId,
      paymentId: proof.paymentId,
      signature: proof.signature,
      amount: order.amount,
      notes: { purpose: "course_registration", courseId: String(course._id), token: String(token), plan: String(plan) },
    });
    if (problem) return { error: problem };
    order =
      (await PaymentOrder.findOneAndUpdate(
        { _id: order._id, status: "created" },
        { $set: { status: "paid", razorpayPaymentId: proof.paymentId, paidAt: new Date() } },
        { returnDocument: "after" }
      )) || (await PaymentOrder.findById(order._id));
  }
  if (order.status !== "paid") return { error: "This payment cannot be used" };
  return { order };
};

const markRegistrationFulfilled = async (order, student, payment) => {
  order.status = "fulfilled";
  order.student = student._id;
  order.payment = payment._id;
  order.fulfilledAt = new Date();
  await order.save();
};

// ---- background safety net ---------------------------------------------------

// Finds orders the student paid on Razorpay but whose browser never came back
// (closed tab, lost network) and finishes them. Dues / installment payments are
// recorded on the spot; a registration payment is marked paid so the student's
// next attempt reuses it instead of paying again.
const reconcileOrders = async () => {
  const now = Date.now();
  let settled = 0;

  const pending = await PaymentOrder.find({
    status: "created",
    mode: "gateway",
    createdAt: { $lt: new Date(now - 2 * 60 * 1000), $gt: new Date(now - 3 * DAY_MS) },
  }).limit(100);

  for (const order of pending) {
    try {
      const gateway = await getGateway(order.admin);
      if (!gateway) continue;
      const paymentId = await fetchCapturedPayment(gateway, order.razorpayOrderId);
      if (!paymentId) continue;
      const claimed = await PaymentOrder.findOneAndUpdate(
        { _id: order._id, status: "created" },
        { $set: { status: "paid", razorpayPaymentId: paymentId, paidAt: new Date() } },
        { returnDocument: "after" }
      );
      if (!claimed) continue;
      if (claimed.purpose !== "course_registration") {
        await fulfilStudentOrder(claimed);
        settled += 1;
      }
    } catch (err) {
      console.error("[payment-orders] could not settle", order.razorpayOrderId, err.message);
    }
  }

  // Paid but a step failed earlier: try recording again.
  const stuck = await PaymentOrder.find({
    status: "paid",
    purpose: { $in: ["dues", "next_installment", "custom"] },
    paidAt: { $lt: new Date(now - 60 * 1000) },
  }).limit(50);
  for (const order of stuck) {
    try {
      await fulfilStudentOrder(order);
      settled += 1;
    } catch (err) {
      console.error("[payment-orders] could not record", order.razorpayOrderId, err.message);
    }
  }

  await PaymentOrder.updateMany({ status: "created", createdAt: { $lt: new Date(now - 3 * DAY_MS) } }, { $set: { status: "abandoned" } });
  return { settled };
};

module.exports = {
  fail,
  respondError,
  receiptNo,
  publicPayment,
  cycleDaysOf,
  openStudentOrder,
  payStudentOrder,
  alreadyRecorded,
  openRegistrationOrder,
  claimRegistrationOrder,
  markRegistrationFulfilled,
  reconcileOrders,
};
