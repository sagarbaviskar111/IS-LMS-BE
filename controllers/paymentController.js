const { closeOutIfFullyPaid } = require("../utils/feeStatus");
const {
  hasSchedule,
  applyPayment,
  isCaughtUp,
  totalRemaining,
  syncFromSchedule,
  publicSchedule,
} = require("../utils/installmentSchedule");
const { paymentDeadline, DAY_MS } = require("../utils/paymentCycle");
const { getFeeRules } = require("../utils/feeRules");
const { remainingOf } = require("../utils/installmentSchedule");
const User = require("../models/User");
const Payment = require("../models/Payment");
const PaymentOrder = require("../models/PaymentOrder");
const paginate = require("../utils/paginate");

const loadOwnedStudent = async (req) => {
  const student = await User.findOne({ _id: req.params.id, admin: req.user._id, role: "student" });
  if (!student) return { error: [404, "Student not found"] };
  return { student, graceDays: (await getFeeRules(req.user._id)).graceDays };
};

const publicAdjustments = (student) =>
  (student.feeAdjustments || []).map((a) => ({ _id: a._id, kind: a.kind, amount: a.amount, note: a.note, createdAt: a.createdAt }));

const summaryOf = (student, graceDays) => ({
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
  paymentDeadline: paymentDeadline(student, graceDays),
  graceDays,
  schedule: publicSchedule(student),
  adjustments: publicAdjustments(student),
});

exports.getStudentPayment = async (req, res) => {
  try {
    const { student, graceDays, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    if (syncFromSchedule(student)) await student.save();

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
      student: summaryOf(student, graceDays),
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
    const { student, graceDays, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { installmentAmount, balanceDue, nextDueDate } = req.body;
    if (hasSchedule(student)) {
      return res.status(400).json({
        message: "This student's fees follow an installment schedule — edit the installment's date or amount instead",
      });
    }
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
    if (nextDueDate !== undefined) {
      const date = new Date(nextDueDate);
      if (nextDueDate === null || Number.isNaN(date.getTime())) {
        return res.status(400).json({ message: "nextDueDate must be a valid date" });
      }
      student.nextDueDate = date;
    }

    await student.save();
    res.json({ student: summaryOf(student, graceDays) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.recordPayment = async (req, res) => {
  try {
    const { student, graceDays, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { amount, note } = req.body;
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ message: "amount must be a positive number" });
    }

    if (hasSchedule(student)) {
      if (amount > totalRemaining(student) + 0.005) {
        return res
          .status(400)
          .json({ message: `Amount can't be more than the remaining course fee (₹${totalRemaining(student)})` });
      }
      applyPayment(student, amount);
    } else {
      student.balanceDue = Math.max(0, (student.balanceDue || 0) - amount);
    }
    const caughtUp = isCaughtUp(student);

    // A cleared balance while deactivated for non-payment (cycle lapse) reactivates the account.
    if (student.deactivatedForPayment && caughtUp) {
      student.isActive = true;
      student.deactivatedForPayment = false;
      if (!hasSchedule(student)) student.paymentGraceUntil = null;
    }

    // A cleared balance while still awaiting the initial registration payment
    // (e.g. cash collected in person instead of paying online) also activates
    // the account — otherwise a fully-paid student stays locked out forever.
    if (student.paymentPending && caughtUp) {
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
    await closeOutIfFullyPaid(student);

    res.status(201).json({ payment, student: summaryOf(student, graceDays) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// The later of "now" and the current deadline — extra days are always counted
// from here, so an extension adds on top of the due date + grace days.
const extensionBase = (student, graceDays) => {
  const deadline = paymentDeadline(student, graceDays);
  return deadline && deadline > new Date() ? deadline : new Date();
};

exports.extendDeadline = async (req, res) => {
  try {
    const { student, graceDays, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const days = Number(req.body.days);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      return res.status(400).json({ message: "Enter the number of extra days (1–365)" });
    }

    student.paymentGraceUntil = new Date(extensionBase(student, graceDays).getTime() + days * DAY_MS);
    await student.save();
    res.json({ student: summaryOf(student, graceDays) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.reactivateStudent = async (req, res) => {
  try {
    const { student, graceDays, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    // Without fresh extra days the payment job would deactivate the account
    // again at once (the deadline has already passed), so a reactivation
    // always buys some more days on top; default 3.
    const days = Number(req.body?.days) > 0 ? Number(req.body.days) : 3;
    student.isActive = true;
    student.deactivatedForPayment = false;
    student.paymentPending = false;
    student.deactivationMessage = null;
    student.paymentGraceUntil = new Date(extensionBase(student, graceDays).getTime() + days * DAY_MS);
    await student.save();

    res.json({ student: summaryOf(student, graceDays) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Admin edits one installment of a student's schedule: move its due date, or
// change the amount of one that isn't fully paid yet. The student's current
// installment, balance and next due date follow from the result.
exports.editInstallment = async (req, res) => {
  try {
    const { student, graceDays, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const item = (student.installmentSchedule || []).id(req.params.itemId);
    if (!item) return res.status(404).json({ message: "Installment not found" });

    const { dueDate, amount } = req.body;
    if (dueDate !== undefined) {
      const date = new Date(dueDate);
      if (Number.isNaN(date.getTime())) return res.status(400).json({ message: "A valid due date is required" });
      item.dueDate = date;
    }
    if (amount !== undefined) {
      if (typeof amount !== "number" || amount < (item.paid || 0)) {
        return res.status(400).json({ message: "Amount can't be less than what is already paid for it" });
      }
      item.amount = amount;
    }

    syncFromSchedule(student);
    await student.save();
    res.json({ student: summaryOf(student, graceDays) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Scholarship, discount or sibling discount for a student: takes money off what is
// still unpaid. A percentage is of the unpaid part of the course fee (or, for a
// batch-fee student, of one installment, which then stays lower every cycle).
exports.addConcession = async (req, res) => {
  try {
    const { student, graceDays, error } = await loadOwnedStudent(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const kind = req.body.kind;
    if (!["scholarship", "discount", "sibling"].includes(kind)) {
      return res.status(400).json({ message: "Choose scholarship, discount or sibling discount" });
    }
    let mode = req.body.mode === "flat" ? "flat" : "percent";
    let value = Number(req.body.value);
    if (kind === "sibling") {
      if ((student.feeAdjustments || []).some((a) => a.kind === "sibling")) {
        return res.status(400).json({ message: "A sibling discount was already given to this student" });
      }
      const percent = (await getFeeRules(req.user._id)).siblingDiscountPercent;
      if (!(percent > 0)) {
        return res.status(400).json({ message: "Set the sibling discount % in Fee rules first" });
      }
      mode = "percent";
      value = percent;
    }
    if (!Number.isFinite(value) || value <= 0 || (mode === "percent" && value > 100)) {
      return res.status(400).json({ message: mode === "percent" ? "Enter a percentage from 1 to 100" : "Enter an amount above 0" });
    }

    const scheduled = hasSchedule(student);
    const base = scheduled ? totalRemaining(student) : student.installmentAmount || 0;
    if (!(base > 0)) return res.status(400).json({ message: "This student has nothing left to give a discount on" });
    const amount = Math.round((mode === "percent" ? (base * value) / 100 : value) * 100) / 100;
    if (amount > base + 0.005) {
      return res.status(400).json({ message: `The discount can't be more than the unpaid fee (₹${base})` });
    }

    if (scheduled) {
      // Spread over the unpaid installments in proportion to what each still needs.
      const open = student.installmentSchedule.filter((i) => remainingOf(i) > 0.005);
      let left = amount;
      open.forEach((item, idx) => {
        const share = idx === open.length - 1 ? left : Math.round(((amount * remainingOf(item)) / base) * 100) / 100;
        const cut = Math.min(share, remainingOf(item));
        item.amount = Math.round((item.amount - cut) * 100) / 100;
        left = Math.round((left - cut) * 100) / 100;
      });
      student.markModified("installmentSchedule");
      syncFromSchedule(student);
    } else {
      student.installmentAmount = Math.max(0, Math.round((student.installmentAmount - amount) * 100) / 100);
      student.balanceDue = Math.max(0, Math.round((student.balanceDue - amount) * 100) / 100);
    }

    const label = { scholarship: "Scholarship", discount: "Discount", sibling: "Sibling discount" }[kind];
    const note = String(req.body.note || "").trim().slice(0, 200);
    student.feeAdjustments.push({
      kind,
      amount: -amount,
      note: note || `${label}${mode === "percent" ? ` ${value}%` : ""}`,
    });

    const caughtUp = isCaughtUp(student);
    if (student.deactivatedForPayment && caughtUp) {
      student.isActive = true;
      student.deactivatedForPayment = false;
    }
    await student.save();
    await closeOutIfFullyPaid(student);
    res.status(201).json({ student: summaryOf(student, graceDays) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Online payments the institute should look at: money Razorpay confirmed that
// is not yet recorded (e.g. a registration the student did not finish), or
// more money than was owed.
exports.attentionOrders = async (req, res) => {
  try {
    const orders = await PaymentOrder.find({
      admin: req.user._id,
      $or: [
        { status: "paid", paidAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) } },
        { status: "fulfilled", excess: { $gt: 0 } },
      ],
    })
      .populate("student", "name email")
      .sort({ paidAt: -1 })
      .limit(50);
    res.json({
      orders: orders.map((o) => ({
        _id: o._id,
        purpose: o.purpose,
        amount: o.amount,
        excess: o.excess,
        status: o.status,
        paidAt: o.paidAt,
        student: o.student ? { name: o.student.name, email: o.student.email } : null,
        email: o.meta?.email || null,
        razorpayOrderId: o.razorpayOrderId,
        razorpayPaymentId: o.razorpayPaymentId,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
