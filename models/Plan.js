const mongoose = require("mongoose");

// A subscription plan an institute can buy. Fully managed by the superadmin.
const planSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    tagline: { type: String, trim: true, maxlength: 160, default: "" },
    // Rupees, before GST. 0 = free plan.
    priceMonthly: { type: Number, default: 0, min: 0 },
    priceYearly: { type: Number, default: 0, min: 0 },
    // 0 = unlimited.
    studentLimit: { type: Number, default: 0, min: 0 },
    features: { type: [String], default: [] },
    isPopular: { type: Boolean, default: false },
    // Inactive plans can't be bought; existing subscribers keep them.
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Plan", planSchema);
