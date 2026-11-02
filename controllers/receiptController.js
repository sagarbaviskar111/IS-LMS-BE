const fs = require("fs");
const path = require("path");
const Payment = require("../models/Payment");
const User = require("../models/User");
const Course = require("../models/Course");
const CourseRegistration = require("../models/CourseRegistration");
const { shapeInstitute } = require("../utils/institute");
const { REGISTRATION_UPLOAD_DIR } = require("../utils/upload");

const METHOD_LABELS = { razorpay: "Online (Razorpay)", online: "Online", manual: "Cash / manual" };

const buildReceipt = async (payment) => {
  const [student, admin] = await Promise.all([
    User.findById(payment.student).select("name email phone course"),
    User.findById(payment.admin).select("name instituteSlug logo brandColor"),
  ]);
  const course = student?.course ? await Course.findById(student.course).select("name") : null;
  const recordedBy = payment.recordedBy ? await User.findById(payment.recordedBy).select("name role") : null;

  return {
    receiptNo: `RCPT-${String(payment._id).slice(-8).toUpperCase()}`,
    paidAt: payment.createdAt,
    amount: payment.amount,
    status: payment.status,
    method: METHOD_LABELS[payment.method] || payment.method,
    note: payment.note || "",
    transactionId: payment.razorpayPaymentId || "",
    receivedBy: recordedBy ? `${recordedBy.name} (${recordedBy.role})` : "Online payment",
    student: { name: student?.name || payment.studentName || "", email: student?.email || "", phone: student?.phone || "" },
    course: course?.name || "",
    institute: shapeInstitute(admin) || { name: admin?.name || "", slug: "", logoUrl: null },
  };
};

// Student: a receipt for one of their own payments.
exports.studentReceipt = async (req, res) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, student: req.user._id }).catch(() => null);
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    res.json({ receipt: await buildReceipt(payment) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Admin: a receipt for any payment of their institute's students.
exports.adminReceipt = async (req, res) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, admin: req.user._id }).catch(() => null);
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    res.json({ receipt: await buildReceipt(payment) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// --- Student: their own submitted registration (view only) ---

const latestRegistration = (studentId) => CourseRegistration.findOne({ student: studentId }).sort({ createdAt: -1 });

exports.myRegistration = async (req, res) => {
  try {
    const reg = await latestRegistration(req.user._id).populate("course", "name");
    if (!reg) return res.json({ registration: null });
    res.json({
      registration: {
        name: reg.name,
        email: reg.email,
        phone: reg.phone,
        dateOfBirth: reg.dateOfBirth,
        address: reg.address,
        course: reg.course?.name || "",
        plan: reg.plan,
        planTotal: reg.planTotal,
        amountPaid: reg.amountPaid,
        registeredAt: reg.createdAt,
        documents: [
          { kind: "id1", label: reg.idProofs[0]?.docType || "ID proof 1", mimetype: reg.idProofs[0]?.mimetype || "" },
          { kind: "id2", label: reg.idProofs[1]?.docType || "ID proof 2", mimetype: reg.idProofs[1]?.mimetype || "" },
          { kind: "selfie", label: "Verification photo", mimetype: reg.selfie?.mimetype || "" },
          { kind: "signature", label: "Signature", mimetype: reg.signature?.mimetype || "" },
        ].filter((d) => d.mimetype),
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.myRegistrationFile = async (req, res) => {
  try {
    const reg = await latestRegistration(req.user._id);
    if (!reg) return res.status(404).json({ message: "Registration not found" });
    const kind = req.params.kind;
    const file =
      kind === "id1" ? reg.idProofs[0] : kind === "id2" ? reg.idProofs[1] : kind === "selfie" ? reg.selfie : kind === "signature" ? reg.signature : null;
    if (!file) return res.status(404).json({ message: "File not found" });

    const full = path.join(REGISTRATION_UPLOAD_DIR, path.basename(file.filename));
    if (!fs.existsSync(full)) return res.status(404).json({ message: "File is missing from storage" });
    res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(full);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
