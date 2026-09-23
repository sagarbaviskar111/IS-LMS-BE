const User = require("../models/User");
const Payment = require("../models/Payment");
const paginate = require("../utils/paginate");

const loadOwnedStudent = async (req) => {
  const student = await User.findOne({ _id: req.params.id, admin: req.user._id, role: "student" });
  if (!student) return { error: [404, "Student not found"] };
  return { student };
};

const summaryOf = (student) => ({
  _id: student._id,
  name: student.name,
  email: student.email,
  installmentAmount: student.installmentAmount,
  balanceDue: student.balanceDue,
  nextDueDate: student.nextDueDate,
  paymentGraceUntil: student.paymentGraceUntil,
  isActive: student.isActive,
  deactivatedForPayment: student.deactivatedForPayment,
  paymentPending: student.paymentPending,
});

exports.getStudentPayment = async (req, res) => {
  try {
    const { student, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { page, limit, skip } = paginate(req);
    const filter = { student: student._id };
    const [history, total] = await Promise.all([
      Payment.find(filter)
        .populate("recordedBy", "name role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Payment.countDocuments(filter),
    ]);

    res.json({
      student: summaryOf(student),
      history,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updatePaymentDetails = async (req, res) => {
  try {
    const { student, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { installmentAmount, balanceDue } = req.body;
    if (installmentAmount !== undefined) {
      if (typeof installmentAmount !== "number" || installmentAmount < 0) {
        return res.status(400).json({ message: "installmentAmount must be a non-negative number" });
      }
      student.installmentAmount = installmentAmount;
    }
    if (balanceDue !== undefined) {
      if (typeof balanceDue !== "number" || balanceDue < 0) {
        return res.status(400).json({ message: "balanceDue must be a non-negative number" });
      }
      student.balanceDue = balanceDue;
    }

    await student.save();
    res.json({ student: summaryOf(student) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.recordPayment = async (req, res) => {
  try {
    const { student, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { amount, note } = req.body;
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ message: "amount must be a positive number" });
    }

    student.balanceDue = Math.max(0, (student.balanceDue || 0) - amount);

    // A cleared balance while deactivated for non-payment (cycle lapse) reactivates the account.
    if (student.deactivatedForPayment && student.balanceDue === 0) {
      student.isActive = true;
      student.deactivatedForPayment = false;
      student.paymentGraceUntil = null;
    }

    // A cleared balance while still awaiting the initial registration payment
    // (e.g. cash collected in person instead of paying online) also activates
    // the account — otherwise a fully-paid student stays locked out forever.
    if (student.paymentPending && student.balanceDue === 0) {
      student.isActive = true;
      student.paymentPending = false;
    }

    await student.save();

    const payment = await Payment.create({
      student: student._id,
      admin: req.user._id,
      batch: student.batch || null,
      amount,
      method: "manual",
      status: "paid",
      recordedBy: req.user._id,
      note,
    });

    res.status(201).json({ payment, student: summaryOf(student) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.extendDeadline = async (req, res) => {
  try {
    const { student, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { until } = req.body;
    const date = new Date(until);
    if (!until || Number.isNaN(date.getTime())) {
      return res.status(400).json({ message: "A valid until date is required" });
    }

    student.paymentGraceUntil = date;
    await student.save();
    res.json({ student: summaryOf(student) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.reactivateStudent = async (req, res) => {
  try {
    const { student, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    student.isActive = true;
    student.deactivatedForPayment = false;
    student.paymentPending = false;
    student.paymentGraceUntil = null;
    await student.save();

    res.json({ student: summaryOf(student) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
