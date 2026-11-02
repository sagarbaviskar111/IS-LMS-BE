const { closeOutIfFullyPaid } = require("./feeStatus");
const { hasSchedule, syncFromSchedule, remainingOf } = require("./installmentSchedule");
const { DEFAULT_GRACE_DAYS, getFeeRules, rulesOf, lateFeeTarget } = require("./feeRules");

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

const REMINDER_GAP_MS = 20 * 60 * 60 * 1000;

// When an unpaid account gets deactivated: the end of the institute's extra days
// after the due date, or the admin-granted extension if that is later.
const paymentDeadline = (student, graceDays = DEFAULT_GRACE_DAYS) => {
  if (!student.nextDueDate) return null;
  const base = new Date(student.nextDueDate.getTime() + graceDays * DAY_MS);
  return student.paymentGraceUntil && student.paymentGraceUntil > base ? student.paymentGraceUntil : base;
};

// Adds today's late fee (if the institute has one) for the due date that has passed.
// Returns true when the student was changed.
const applyLateFee = (student, rules, now) => {
  const due = student.nextDueDate;
  if (!(student.balanceDue > 0) || !due || due > now) return false;
  const sameDue = student.lateFee?.forDue && student.lateFee.forDue.getTime() === due.getTime();
  const applied = sameDue ? student.lateFee.applied || 0 : 0;
  const delta = Math.round((lateFeeTarget(rules, now, due) - applied) * 100) / 100;
  if (!(delta > 0)) return false;

  if (hasSchedule(student)) {
    const item = [...student.installmentSchedule]
      .filter((i) => remainingOf(i) > 0.005)
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];
    if (!item) return false;
    item.amount = Math.round((item.amount + delta) * 100) / 100;
    item.fine = Math.round(((item.fine || 0) + delta) * 100) / 100;
    student.markModified("installmentSchedule");
    syncFromSchedule(student, now);
  } else {
    student.balanceDue = Math.round((student.balanceDue + delta) * 100) / 100;
  }
  student.lateFee = { forDue: due, applied: Math.round((applied + delta) * 100) / 100 };

  // One ledger line per due date; a per-day fee just grows it.
  const ref = `late:${due.getTime()}`;
  const line = student.feeAdjustments.find((a) => a.ref === ref);
  if (line) line.amount = Math.round((line.amount + delta) * 100) / 100;
  else student.feeAdjustments.push({ kind: "late_fee", amount: delta, ref, note: "Late fee" });
  return true;
};

const reminderText = (student, deadline, now) => {
  const amount = student.balanceDue;
  const due = student.nextDueDate.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  if (student.nextDueDate > now) {
    return `Hi ${student.name}, your fee of ₹${amount} is due on ${due}. Please pay on time to keep your account active.`;
  }
  const last = deadline.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  const fine = student.lateFee?.applied > 0 ? ` (includes a late fee of ₹${student.lateFee.applied})` : "";
  return `Hi ${student.name}, your fee of ₹${amount}${fine} was due on ${due}. Please pay by ${last} — after that your account will be deactivated until the dues are cleared.`;
};

// Deactivates the student right now if their unpaid-fee deadline (due date +
// extra days, or the admin extension) has passed, instead of waiting for the
// periodic job. Returns true if the account was just deactivated.
const enforceFeeDeadline = async (student) => {
  if (student.role !== "student" || !student.isActive || !(student.balanceDue > 0)) return false;
  const { graceDays } = await getFeeRules(student.admin);
  const deadline = paymentDeadline(student, graceDays);
  if (!deadline || deadline > new Date()) return false;
  student.isActive = false;
  student.deactivatedForPayment = true;
  student.paymentGraceUntil = null;
  await student.save();
  return true;
};

// Runs periodically over every active student with a payment cycle in
// progress. For each one:
//  - the due date has passed, they still owe money, and the extra grace days
//    (or an admin extension) are over: deactivate the account for non-payment.
//  - they owe money and the due date is within a day or already passed (but
//    still inside the grace period): email one reminder a day (from the institute's own sender email).
//  - the due date has passed but the balance is already clear: roll over to
//    the next cycle (charge the next installment, push the due date out).
const runPaymentCycleCheck = async (User, sendMessage) => {
  const now = new Date();
  const students = await User.find({
    role: "student",
    isActive: true,
    nextDueDate: { $ne: null, $lte: new Date(now.getTime() + DAY_MS) },
  })
    .sort({ nextDueDate: 1 }) // most overdue first, so they get the daily email slots
    .populate("batch", "paymentCycleDays");

  // Each institute has its own grace days and late fee.
  const rulesByAdmin = new Map();
  for (const adminId of new Set(students.map((x) => String(x.admin)))) {
    rulesByAdmin.set(adminId, await getFeeRules(adminId));
  }

  let deactivated = 0;
  let rolledOver = 0;
  let reminded = 0;

  for (const student of students) {
    // Course students: re-derive what's owed from their installment schedule
    // (a later installment may have just fallen due) before deciding anything.
    if (hasSchedule(student)) {
      syncFromSchedule(student, now);
      if (student.isModified()) await student.save();
    }
    const rules = rulesByAdmin.get(String(student.admin)) || rulesOf(null);
    const deadline = paymentDeadline(student, rules.graceDays);

    if (student.balanceDue > 0) {
      if (deadline > now && applyLateFee(student, rules, now)) await student.save();
      if (deadline <= now) {
        student.isActive = false;
        student.deactivatedForPayment = true;
        student.paymentGraceUntil = null;
        await student.save();
        deactivated += 1;
        continue;
      }
      const lastSent = student.lastFeeReminderAt;
      if (sendMessage && (!lastSent || now - lastSent >= REMINDER_GAP_MS)) {
        const result = await sendMessage(student, {
          subject: student.nextDueDate > now ? "Fee due soon" : "Fee overdue",
          text: reminderText(student, deadline, now),
        }).catch((err) => ({ sent: false, reason: err.message }));
        // Over the institute's daily email limit: leave this student unstamped so
        // they are first in line when the limit resets tomorrow.
        if (result.limited) continue;
        if (result.sent) reminded += 1;
        else console.log(`[fee-reminder] ${student.email}: ${result.reason}`);
        // Stamp even on failure so a bad address isn't retried every 15 minutes.
        student.lastFeeReminderAt = now;
        await student.save();
      }
      continue;
    }

    if (hasSchedule(student) || student.nextDueDate > now) continue;

    // Course fee already paid in full: end the cycle instead of charging again.
    if (await closeOutIfFullyPaid(student)) continue;

    const cycleDays = student.batch?.paymentCycleDays || 30;
    student.balanceDue += student.installmentAmount || 0;
    student.nextDueDate = new Date(student.nextDueDate.getTime() + cycleDays * DAY_MS);
    student.paymentGraceUntil = null;
    await student.save();
    rolledOver += 1;
  }

  return { deactivated, rolledOver, reminded, checked: students.length };
};

module.exports = { initPaymentTerms, ensurePaymentTermsFromBatch, runPaymentCycleCheck, enforceFeeDeadline, paymentDeadline, applyLateFee, DAY_MS };
