// A course student's full installment plan, stored on the student at
// admission: every installment has its own due date. The flat fields the rest
// of the app reads (balanceDue, nextDueDate, installmentAmount) are derived
// from it by syncFromSchedule, so a payment — or an admin moving a date —
// automatically makes the following installment the "current" one.
const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const EPS = 0.005;

const remainingOf = (item) => round2(Math.max(0, item.amount - (item.paid || 0)));
const hasSchedule = (student) => Array.isArray(student.installmentSchedule) && student.installmentSchedule.length > 0;
const byDueDate = (a, b) => new Date(a.dueDate) - new Date(b.dueDate);

// Spreads `amount` over the unpaid installments, earliest due date first.
// Returns whatever was left over once everything is paid.
const applyToItems = (items, amount) => {
  let left = round2(amount);
  for (const item of [...items].sort(byDueDate)) {
    if (left <= EPS) break;
    const take = Math.min(left, remainingOf(item));
    if (take <= 0) continue;
    item.paid = round2((item.paid || 0) + take);
    left = round2(left - take);
  }
  return left;
};

// Builds the schedule from a course plan (see utils/coursePayment buildSchedule),
// counting `amountPaid` already collected. Due dates run from `start`.
const buildStudentSchedule = (plan, amountPaid, start = new Date()) => {
  const items = plan.map((p, i) => ({
    label: p.label || `Installment ${i + 1}`,
    amount: p.amount,
    dueAfterDays: p.dueAfterDays || 0,
    dueDate: new Date(start.getTime() + (p.dueAfterDays || 0) * DAY_MS),
    paid: 0,
  }));
  applyToItems(items, amountPaid || 0);
  return items;
};

// Restarts the due dates from `start` (the day the student actually joins).
const rebaseSchedule = (student, start = new Date()) => {
  for (const item of student.installmentSchedule) {
    item.dueDate = new Date(start.getTime() + (item.dueAfterDays || 0) * DAY_MS);
  }
};

// Recomputes balanceDue / nextDueDate / installmentAmount from the schedule.
// Returns true if anything changed. When the current installment changes
// (previous one paid, or its date moved), the extension and reminder state
// belonging to the old date are cleared.
const syncFromSchedule = (student, now = new Date()) => {
  if (!hasSchedule(student)) return false;

  const unpaid = student.installmentSchedule.filter((i) => remainingOf(i) > EPS).sort(byDueDate);
  let balanceDue = 0;
  let nextDueDate = null;
  let installmentAmount = 0;
  if (unpaid.length) {
    const first = unpaid[0];
    const overdue = unpaid.filter((i) => new Date(i.dueDate) <= now);
    balanceDue = round2((overdue.length ? overdue : [first]).reduce((sum, i) => sum + remainingOf(i), 0));
    nextDueDate = new Date(first.dueDate);
    installmentAmount = remainingOf(first);
  }

  const dateChanged = (student.nextDueDate ? student.nextDueDate.getTime() : null) !== (nextDueDate ? nextDueDate.getTime() : null);
  const changed =
    dateChanged || student.balanceDue !== balanceDue || student.installmentAmount !== installmentAmount;

  student.balanceDue = balanceDue;
  student.installmentAmount = installmentAmount;
  student.nextDueDate = nextDueDate;
  if (dateChanged) {
    student.paymentGraceUntil = null;
    student.lastFeeReminderAt = null;
  }
  return changed;
};

// Puts `amount` on one chosen installment only (the student picked it). Returns what
// did not fit because the installment needed less.
const applyToItem = (student, item, amount) => {
  const take = Math.min(round2(amount), remainingOf(item));
  item.paid = round2((item.paid || 0) + take);
  student.markModified("installmentSchedule");
  syncFromSchedule(student);
  return round2(amount - take);
};

// Records `amount` against the schedule and re-derives the flat fields.
// Returns the part that could not be applied (more than was owed).
const applyPayment = (student, amount) => {
  const left = applyToItems(student.installmentSchedule, amount);
  student.markModified("installmentSchedule");
  syncFromSchedule(student);
  return left;
};

// True when nothing is overdue any more. Scheduled students always show the
// current installment as balanceDue, so "balance is zero" is the wrong test.
const isCaughtUp = (student, now = new Date()) =>
  hasSchedule(student) ? !student.nextDueDate || student.nextDueDate > now : !(student.balanceDue > 0);

const totalRemaining = (student) =>
  round2((student.installmentSchedule || []).reduce((sum, i) => sum + remainingOf(i), 0));

const publicSchedule = (student) =>
  [...(student.installmentSchedule || [])].sort(byDueDate).map((i) => ({
    _id: i._id,
    label: i.label,
    amount: i.amount,
    paid: i.paid || 0,
    fine: i.fine || 0,
    dueDate: i.dueDate,
    status: remainingOf(i) <= EPS ? "paid" : (i.paid || 0) > 0 ? "partial" : "pending",
  }));

module.exports = {
  hasSchedule,
  buildStudentSchedule,
  rebaseSchedule,
  syncFromSchedule,
  applyPayment,
  applyToItem,
  totalRemaining,
  isCaughtUp,
  publicSchedule,
  remainingOf,
};
