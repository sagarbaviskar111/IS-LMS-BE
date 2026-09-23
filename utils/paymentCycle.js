const DAY_MS = 24 * 60 * 60 * 1000;

// Sets a student's initial payment terms when they're first given an
// installment amount (registration time) or first assigned to a batch.
// Charges the first cycle immediately (due now) and schedules the next one.
const initPaymentTerms = (student, { installmentAmount, cycleDays }) => {
  student.installmentAmount = installmentAmount || 0;
  student.balanceDue = installmentAmount || 0;
  student.nextDueDate = new Date(Date.now() + (cycleDays || 30) * DAY_MS);
  student.paymentGraceUntil = null;
};

// Backfills payment terms for a student who's being assigned to a batch for
// the first time and doesn't already have a cycle running.
const ensurePaymentTermsFromBatch = (student, batch) => {
  if (!batch || student.nextDueDate) return;
  if (!batch.defaultFee) return;
  initPaymentTerms(student, { installmentAmount: batch.defaultFee, cycleDays: batch.paymentCycleDays });
};

// Runs periodically over every active student with a payment cycle in
// progress. For each one:
//  - if the due date (or an admin-granted grace date) has passed and they
//    still owe money, deactivate the account for non-payment.
//  - if the due date has passed but the balance is already clear, roll over
//    to the next cycle (charge the next installment, push the due date out).
const runPaymentCycleCheck = async (User) => {
  const now = new Date();
  const students = await User.find({
    role: "student",
    isActive: true,
    nextDueDate: { $ne: null, $lte: now },
  }).populate("batch", "paymentCycleDays");

  let deactivated = 0;
  let rolledOver = 0;

  for (const student of students) {
    const deadline = student.paymentGraceUntil && student.paymentGraceUntil > student.nextDueDate
      ? student.paymentGraceUntil
      : student.nextDueDate;

    if (deadline > now) continue; // grace period pushed the real deadline into the future

    if (student.balanceDue > 0) {
      student.isActive = false;
      student.deactivatedForPayment = true;
      student.paymentGraceUntil = null;
      await student.save();
      deactivated += 1;
      continue;
    }

    const cycleDays = student.batch?.paymentCycleDays || 30;
    student.balanceDue += student.installmentAmount || 0;
    student.nextDueDate = new Date(student.nextDueDate.getTime() + cycleDays * DAY_MS);
    student.paymentGraceUntil = null;
    await student.save();
    rolledOver += 1;
  }

  return { deactivated, rolledOver, checked: students.length };
};

module.exports = { initPaymentTerms, ensurePaymentTermsFromBatch, runPaymentCycleCheck, DAY_MS };
