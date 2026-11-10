const mongoose = require("mongoose");

// An institute paying the platform for a subscription period.
const billingPaymentSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null },
    planName: { type: String, default: "" },
    interval: { type: String, enum: ["monthly", "yearly"], required: true },
    pricingMode: { type: String, default: "plan" },
    students: { type: Number, default: 0 }, // billed student count (per_student mode)
    base: { type: Number, required: true }, // rupees before GST
    gst: { type: Number, default: 0 },
    total: { type: Number, required: true },
    mode: { type: String, enum: ["gateway", "dev", "manual"], default: "gateway" },
    razorpayOrderId: { type: String, default: null, unique: true, sparse: true },
    razorpayPaymentId: { type: String, default: null },
    status: { type: String, enum: ["created", "paid"], default: "created" },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BillingPayment", billingPaymentSchema);
