const mongoose = require("mongoose");

// Single document holding how the platform itself charges institutes.
const platformSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "platform", unique: true },
    // "plan": institutes buy one of the fixed plans (student cap per plan).
    // "per_student": price = active students x perStudentPrice (no cap).
    pricingMode: { type: String, enum: ["plan", "per_student"], default: "plan" },
    perStudentPrice: { type: Number, default: 10, min: 0 }, // rupees / student / month
    perStudentMin: { type: Number, default: 50, min: 0 }, // billed for at least this many
    // Discount on the 12-month price in per_student mode (plans carry their own yearly price).
    yearlyDiscountPercent: { type: Number, default: 17, min: 0, max: 90 },
    trialDays: { type: Number, default: 14, min: 0, max: 365 },
    // Student limit while on trial (0 = unlimited).
    trialStudentLimit: { type: Number, default: 50, min: 0 },
    gstPercent: { type: Number, default: 18, min: 0, max: 40 },
    // When false, nobody is blocked for limits / expiry (billing still shown).
    enforceLimits: { type: Boolean, default: true },
    // Open public institute signup.
    signupOpen: { type: Boolean, default: true },
  },
  { timestamps: true }
);

platformSettingsSchema.statics.get = async function () {
  return (await this.findOne({ key: "platform" })) || (await this.create({ key: "platform" }));
};

module.exports = mongoose.model("PlatformSettings", platformSettingsSchema);
