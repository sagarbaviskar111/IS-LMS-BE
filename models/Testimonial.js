const mongoose = require("mongoose");

// A review shown on the public landing page. Platform-wide (not per
// institute) - only the superadmin manages these.
const testimonialSchema = new mongoose.Schema(
  {
    quote: { type: String, required: true, trim: true, maxlength: 600 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    role: { type: String, trim: true, maxlength: 120, default: "" },
    city: { type: String, trim: true, maxlength: 60, default: "" },
    isActive: { type: Boolean, default: true },
    // Lower comes first on the landing page.
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

testimonialSchema.index({ isActive: 1, order: 1, createdAt: 1 });

module.exports = mongoose.model("Testimonial", testimonialSchema);
