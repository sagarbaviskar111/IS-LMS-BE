const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ["razorpay", "manual", "online"], required: true },
    // manual entries are recorded as already paid; razorpay entries are only
    // written to the ledger once payment is verified, so both are effectively "paid".
    status: { type: String, enum: ["paid", "failed"], default: "paid" },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    // The student's name when the payment was made, so receipts and the finance
    // ledger still read correctly if the student account is deleted later.
    studentName: { type: String, trim: true, default: "" },
    // Admin/telecaller who recorded a manual (cash/offline) payment — null for razorpay.
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

paymentSchema.index({ student: 1, createdAt: -1 });
// One Razorpay payment can only ever be recorded once, even if two requests race.
paymentSchema.index({ razorpayPaymentId: 1 }, { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string" } } });

paymentSchema.pre("save", async function () {
  if (this.studentName || !this.student) return;
  const student = await mongoose.model("User").findById(this.student).select("name");
  this.studentName = student?.name || "";
});

// Payments are the books of the institute: nothing in the app deletes them.
// (This guards against a future code path doing it by accident.)
const refuse = function () {
  throw new Error("Payment records are permanent and cannot be deleted");
};
paymentSchema.pre("deleteOne", { document: true, query: true }, refuse);
paymentSchema.pre("deleteMany", refuse);
paymentSchema.pre("findOneAndDelete", refuse);
paymentSchema.index({ admin: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", paymentSchema);
