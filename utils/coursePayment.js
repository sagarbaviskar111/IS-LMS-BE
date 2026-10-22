const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

// The payments a student makes for a plan. The installment charge is folded
// into the first installment so the total is what they really pay.
const buildSchedule = (course, plan) => {
  if (plan === "one_time") {
    if (!course.oneTimeEnabled) return null;
    return [{ label: "Full payment", amount: course.oneTimeAmount, dueAfterDays: 0 }];
  }
  if (plan === "installment") {
    if (!course.installmentEnabled || course.installments.length === 0) return null;
    return course.installments.map((it, i) => ({
      label: it.label || `Installment ${i + 1}`,
      amount: round2(it.amount + (i === 0 ? course.installmentCharge || 0 : 0)),
      dueAfterDays: it.dueAfterDays,
    }));
  }
  return null;
};

// What a student still owes after paying `amountPaid` towards a schedule.
// Anything due at joining that wasn't paid is the balance now; the next later
// installment becomes the next cycle (nextDays = days from joining until it is due).
const paymentTerms = (schedule, amountPaid) => {
  let balanceDue = 0;
  let installmentAmount = 0;
  let nextDays = 0;
  let cumulative = 0;
  for (const item of schedule) {
    const start = cumulative;
    cumulative = round2(cumulative + item.amount);
    const unpaid = round2(Math.max(0, cumulative - Math.max(amountPaid, start)));
    if (unpaid <= 0) continue;
    if (item.dueAfterDays <= 0) balanceDue = round2(balanceDue + unpaid);
    else if (!nextDays) {
      installmentAmount = unpaid;
      nextDays = item.dueAfterDays;
    }
  }
  if (balanceDue > 0 && !nextDays) nextDays = 30;
  return {
    balanceDue,
    installmentAmount,
    nextDays,
    nextDueDate: nextDays ? new Date(Date.now() + nextDays * DAY_MS) : null,
  };
};

module.exports = { DAY_MS, round2, buildSchedule, paymentTerms };
