const mongoose = require("mongoose");

// One online payment attempt, from the moment we open an order on the
// institute's Razorpay account until the money is recorded. It is what lets us
// settle a payment even if the student's browser closes right after paying:
// the order is looked up again (see utils/paymentOrders reconcile) and finished.
//
//   created   - order opened, nothing paid yet
//   paid      - Razorpay confirmed the money; not yet recorded against the student
//   fulfilled - recorded (Payment created, installments updated)
//   abandoned - never paid within 3 days
const paymentOrderSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Null for a course registration until the student account exists.
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    purpose: { type: String, enum: ["dues", "next_installment", "course_registration"], required: true },
    // Rupees, fixed by the server when the order is opened.
    amount: { type: Number, required: true, min: 0 },
    mode: { type: String, enum: ["gateway", "dev"], default: "gateway" },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, default: null },
    status: { type: String, enum: ["created", "paid", "fulfilled", "abandoned"], default: "created" },
    // Course registration only: what the order was opened for.
    meta: {
      courseId: { type: String, default: null },
      token: { type: String, default: null },
      plan: { type: String, default: null },
      email: { type: String, default: null },
    },
    paidAt: { type: Date, default: null },
    fulfilledAt: { type: Date, default: null },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null },
    // Money received beyond what was still owed (e.g. the admin recorded cash
    // while the student was paying). Needs a refund or adjustment by the admin.
    excess: { type: Number, default: 0 },
  },
  { timestamps: true }
);

paymentOrderSchema.index({ admin: 1, status: 1, createdAt: -1 });
paymentOrderSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model("PaymentOrder", paymentOrderSchema);
