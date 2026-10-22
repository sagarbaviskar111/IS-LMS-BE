const crypto = require("crypto");
const Course = require("../models/Course");
const Payment = require("../models/Payment");
const StudentEnrollment = require("../models/StudentEnrollment");
const User = require("../models/User");
const { normalizeEmail, normalizeName, normalizePhone } = require("../utils/validators");
const { round2, buildSchedule, paymentTerms } = require("../utils/coursePayment");

const PAID = ["unpaid", "first_installment", "full"];
const METHODS = { cash: "Cash", upi: "UPI", other: "Other" };
const INCOMPLETE_MESSAGE =
  "Your registration is not complete yet. Please finish it using the registration link from your institute.";

const stateOf = (e) => {
  if (e.usedAt) return "used";
  if (!e.token) return "no_link";
  if (e.expiresAt && e.expiresAt < new Date()) return "expired";
  return "active";
};

const summarize = (e, course) => ({
  _id: e._id,
  student: e.student,
  course: course ? { _id: course._id, name: course.name } : null,
  paidStatus: e.paidStatus,
  plan: e.plan,
  planTotal: e.planTotal,
  amountPaid: e.amountPaid,
  paymentMethod: e.paymentMethod,
  token: e.token || null,
  expiresAt: e.expiresAt,
  usedAt: e.usedAt,
  state: stateOf(e),
});

// Admin registers a student by hand: name, email, phone and a course. The
// student is created deactivated and finishes the rest through a private link.
// If the admin already took the fees (cash / UPI) they say so here, and the
// student's registration then skips the payment step.
exports.registerStudent = async (req, res) => {
  try {
    const b = req.body || {};
    const name = normalizeName(b.name);
    const email = normalizeEmail(b.email);
    const phone = normalizePhone(b.phone);
    if (!name) return res.status(400).json({ message: "Enter the student's full name" });
    if (!email) return res.status(400).json({ message: "Enter a valid email address" });
    if (!phone) return res.status(400).json({ message: "Enter a valid phone number" });

    const course = await Course.findOne({ _id: b.courseId, admin: req.user._id }).catch(() => null);
    if (!course) return res.status(400).json({ message: "Select a course" });

    const paidStatus = PAID.includes(b.paymentStatus) ? b.paymentStatus : "unpaid";
    const method = METHODS[b.paymentMethod] ? b.paymentMethod : "cash";

    if (await User.findOne({ email })) {
      return res.status(409).json({ message: "A user with this email already exists" });
    }

    // Work out the plan and amount for fees already collected.
    let plan = null;
    let planTotal = 0;
    let amountPaid = 0;
    let terms = null;
    if (paidStatus !== "unpaid") {
      plan = paidStatus === "first_installment" ? "installment" : course.oneTimeEnabled ? "one_time" : "installment";
      const schedule = buildSchedule(course, plan);
      if (!schedule) {
        return res.status(400).json({
          message:
            paidStatus === "first_installment"
              ? "This course has no installment plan — choose another payment option"
              : "This course has no fee set up",
        });
      }
      planTotal = round2(schedule.reduce((s, i) => s + i.amount, 0));
      const defaultAmount = paidStatus === "first_installment" ? schedule[0].amount : planTotal;
      amountPaid = b.amount === undefined || b.amount === "" ? defaultAmount : round2(Number(b.amount));
      if (!Number.isFinite(amountPaid) || amountPaid <= 0) return res.status(400).json({ message: "Enter the amount received" });
      if (amountPaid > planTotal) return res.status(400).json({ message: `Amount can't be more than the total fee (₹${planTotal})` });
      terms = paymentTerms(schedule, amountPaid);
    }

    const student = await User.create({
      name,
      email,
      // Nobody knows this: the student picks their own password when they finish registering.
      password: crypto.randomBytes(16).toString("hex"),
      phone,
      role: "student",
      admin: req.user._id,
      course: course._id,
      isActive: false,
      registrationComplete: false,
      deactivationMessage: INCOMPLETE_MESSAGE,
      ...(terms
        ? { installmentAmount: terms.installmentAmount, balanceDue: terms.balanceDue, nextDueDate: terms.nextDueDate }
        : {}),
    });

    if (paidStatus !== "unpaid") {
      await Payment.create({
        student: student._id,
        admin: req.user._id,
        amount: amountPaid,
        method: "manual",
        status: "paid",
        recordedBy: req.user._id,
        note: `${METHODS[method]} — course registration: ${course.name}${b.note ? ` (${String(b.note).trim().slice(0, 200)})` : ""}`,
      });
    }

    const enrollment = await StudentEnrollment.create({
      admin: req.user._id,
      student: student._id,
      course: course._id,
      paidStatus,
      plan,
      planTotal,
      amountPaid,
      paymentMethod: paidStatus === "unpaid" ? "" : METHODS[method],
      nextDays: terms ? terms.nextDays : 0,
    });

    res.status(201).json({ student: student.toJSON(), enrollment: summarize(enrollment, course) });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ message: "A user with this email already exists" });
    res.status(500).json({ message: "Server error" });
  }
};

// The enrollment (course, fees collected, link state) of an admin-registered student.
exports.getStudentEnrollment = async (req, res) => {
  try {
    const enrollment = await StudentEnrollment.findOne({ student: req.params.studentId, admin: req.user._id });
    if (!enrollment) return res.json({ enrollment: null });
    const course = await Course.findById(enrollment.course).select("name");
    res.json({ enrollment: summarize(enrollment, course) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Makes (or replaces) the student's private registration link.
exports.createStudentLink = async (req, res) => {
  try {
    const enrollment = await StudentEnrollment.findOne({ student: req.params.studentId, admin: req.user._id });
    if (!enrollment) return res.status(404).json({ message: "This student was not registered by you through a course" });
    if (enrollment.usedAt) return res.status(400).json({ message: "This student has already completed registration" });

    const hours = Number(req.body?.expiresInHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 60) {
      return res.status(400).json({ message: "Choose when the link should expire" });
    }

    enrollment.token = crypto.randomBytes(20).toString("hex");
    enrollment.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    await enrollment.save();

    const course = await Course.findById(enrollment.course).select("name");
    res.json({ enrollment: summarize(enrollment, course) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
