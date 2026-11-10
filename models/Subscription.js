const mongoose = require("mongoose");

// One per institute (admin). Institutes without one are "legacy": they were
// here before billing existed and are never limited.
const subscriptionSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null },
    status: { type: String, enum: ["trial", "active", "cancelled"], default: "trial" },
    interval: { type: String, enum: ["monthly", "yearly"], default: "monthly" },
    trialEndsAt: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    // Superadmin overrides for this institute only.
    customPrice: { type: Number, default: null, min: 0 }, // rupees per interval, before GST
    studentLimitOverride: { type: Number, default: null, min: 0 },
    note: { type: String, default: "", maxlength: 300 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Subscription", subscriptionSchema);
