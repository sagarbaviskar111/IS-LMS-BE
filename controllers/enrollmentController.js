const crypto = require("crypto");
const Course = require("../models/Course");
const Payment = require("../models/Payment");
const StudentEnrollment = require("../models/StudentEnrollment");
const User = require("../models/User");
const { normalizeEmail, normalizeName, normalizePhone } = require("../utils/validators");
const { round2, buildSchedule, paymentTerms } = require("../utils/coursePayment");
const { buildStudentSchedule, syncFromSchedule } = require("../utils/installmentSchedule");

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

// Creates a student the way "Register student" does: name, email, phone and a
// course. The student is created deactivated and finishes the rest through a
// private link. If fees were already taken (cash / UPI) `paymentStatus` says so
// and the student's registration then skips the payment step.
// Returns { error: [status, message] } or { student, enrollment }.
const createCourseStudent = async ({ adminId, actorId, body }) => {
  const b = body || {};
  const name = normalizeName(b.name);
  const email = normalizeEmail(b.email);
  const phone = normalizePhone(b.phone);
  if (!name) return { error: [400, "Enter the student's full name"] };
  if (!email) return { error: [400, "Enter a valid email address"] };
  if (!phone) return { error: [400, "Enter a valid phone number"] };

  const course = await Course.findOne({ _id: b.courseId, admin: adminId }).catch(() => null);
  if (!course) return { error: [400, "Select a course"] };

  const paidStatus = PAID.includes(b.paymentStatus) ? b.paymentStatus : "unpaid";
  const method = METHODS[b.paymentMethod] ? b.paymentMethod : "cash";

  if (await User.findOne({ email })) {
    return { error: [409, "A user with this email already exists"] };
  }

  // Work out the plan and amount for fees already collected.
  let plan = null;
  let planTotal = 0;
  let amountPaid = 0;
  let terms = null;
  let feePlan = null;
  if (paidStatus !== "unpaid") {
    plan = paidStatus === "first_installment" ? "installment" : course.oneTimeEnabled ? "one_time" : "installment";
    const schedule = buildSchedule(course, plan);
    if (!schedule) {
      return {
        error: [
          400,
          paidStatus === "first_installment"
            ? "This course has no installment plan — choose another payment option"
            : "This course has no fee set up",
        ],
      };
    }
    planTotal = round2(schedule.reduce((sum, i) => sum + i.amount, 0));
    const defaultAmount = paidStatus === "first_installment" ? schedule[0].amount : planTotal;
    amountPaid = b.amount === undefined || b.amount === "" ? defaultAmount : round2(Number(b.amount));
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) return { error: [400, "Enter the amount received"] };
    if (amountPaid > planTotal) return { error: [400, `Amount can't be more than the total fee (₹${planTotal})`] };
    terms = paymentTerms(schedule, amountPaid);
    feePlan = schedule;
  }

  const student = await User.create({
    name,
    email,
    // Nobody knows this: the student picks their own password when they finish registering.
    password: crypto.randomBytes(16).toString("hex"),
    phone,
    role: "student",
    admin: adminId,
    course: course._id,
    isActive: false,
    registrationComplete: false,
    deactivationMessage: INCOMPLETE_MESSAGE,
    ...(terms
      ? { installmentAmount: terms.installmentAmount, balanceDue: terms.balanceDue, nextDueDate: terms.nextDueDate }
      : {}),
  });

  if (feePlan) {
    // Fix every installment's due date now; the dates restart from the day the
    // student finishes registering (see submitRegistration).
    student.installmentSchedule = buildStudentSchedule(feePlan, amountPaid);
    syncFromSchedule(student);
    await student.save();
  }

  if (paidStatus !== "unpaid") {
    await Payment.create({
      student: student._id,
      admin: adminId,
      amount: amountPaid,
      method: "manual",
      status: "paid",
      recordedBy: actorId,
      note: `${METHODS[method]} — course registration: ${course.name}${b.note ? ` (${String(b.note).trim().slice(0, 200)})` : ""}`,
    });
  }

  const enrollment = await StudentEnrollment.create({
    admin: adminId,
    student: student._id,
    course: course._id,
    paidStatus,
    plan,
    planTotal,
    amountPaid,
    paymentMethod: paidStatus === "unpaid" ? "" : METHODS[method],
    nextDays: terms ? terms.nextDays : 0,
  });

  return { student, enrollment, course };
};

// Makes (or replaces) an enrollment's private registration link.
const issueEnrollmentLink = async (enrollment, hours) => {
  enrollment.token = crypto.randomBytes(20).toString("hex");
  enrollment.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  await enrollment.save();
  return enrollment;
};

const validLinkHours = (v) => {
  const hours = Number(v);
  return Number.isInteger(hours) && hours >= 1 && hours <= 24 * 60 ? hours : null;
};

exports.createCourseStudent = createCourseStudent;
exports.issueEnrollmentLink = issueEnrollmentLink;
exports.validLinkHours = validLinkHours;
exports.summarizeEnrollment = summarize;

exports.registerStudent = async (req, res) => {
  try {
    const out = await createCourseStudent({ adminId: req.user._id, actorId: req.user._id, body: req.body });
    if (out.error) return res.status(out.error[0]).json({ message: out.error[1] });
    res.status(201).json({ student: out.student.toJSON(), enrollment: summarize(out.enrollment, out.course) });
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

    const hours = validLinkHours(req.body?.expiresInHours);
    if (!hours) return res.status(400).json({ message: "Choose when the link should expire" });

    await issueEnrollmentLink(enrollment, hours);

    const course = await Course.findById(enrollment.course).select("name");
    res.json({ enrollment: summarize(enrollment, course) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
