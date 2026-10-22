const mongoose = require("mongoose");

// When an admin pastes an HR email address into the "apply link" field
// instead of a real URL (common — a lot of hiring posts just say "mail your
// resume to hr@company.com"), we still let it work as a clickable mailto:
// link for students, but also log it here so the superadmin can see which
// companies are hiring through which institute.
const jobEmailLeadSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true, unique: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    instituteName: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
  },
  { timestamps: true }
);

jobEmailLeadSchema.index({ createdAt: -1 });

module.exports = mongoose.model("JobEmailLead", jobEmailLeadSchema);
