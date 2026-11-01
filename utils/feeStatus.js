const CourseRegistration = require("../models/CourseRegistration");
const Payment = require("../models/Payment");

const round2 = (n) => Math.round(n * 100) / 100;

// Where a student stands against the total fee of the course plan they
// registered with. Returns null for students with no course plan (batch-fee
// students pay a repeating installment with no overall total).
const getFeeStatus = async (student) => {
  const registration = await CourseRegistration.findOne({ student: student._id })
    .sort({ createdAt: -1 })
    .select("planTotal");
  if (!registration) return null;

  const [agg] = await Payment.aggregate([
    { $match: { student: student._id, status: "paid" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const totalPaid = round2(agg?.total || 0);
  const planTotal = round2(registration.planTotal);
  const remaining = round2(Math.max(0, planTotal - totalPaid));
  return { planTotal, totalPaid, remaining, fullyPaid: remaining === 0 && !(student.balanceDue > 0) };
};

// Once the whole course fee is in, stop the fee cycle for good: no more
// installments, due dates, reminders or deactivation. Call after recording a
// payment. Returns true if the student is now fully paid.
const closeOutIfFullyPaid = async (student) => {
  const status = await getFeeStatus(student);
  if (!status?.fullyPaid) return false;
  student.installmentAmount = 0;
  student.balanceDue = 0;
  student.nextDueDate = null;
  student.paymentGraceUntil = null;
  student.lastFeeReminderAt = null;
  await student.save();
  return true;
};

module.exports = { getFeeStatus, closeOutIfFullyPaid };
