const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ["razorpay", "manual"], required: true },
    // manual entries are recorded as already paid; razorpay entries are only
    // written to the ledger once payment is verified, so both are effectively "paid".
    status: { type: String, enum: ["paid", "failed"], default: "paid" },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    // Admin/telecaller who recorded a manual (cash/offline) payment — null for razorpay.
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

paymentSchema.index({ student: 1, createdAt: -1 });
paymentSchema.index({ admin: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", paymentSchema);
