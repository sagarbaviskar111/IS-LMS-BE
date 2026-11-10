const mongoose = require("mongoose");

const STUDENT_BANDS = ["", "under_50", "50_150", "150_300", "300_750", "750_1500", "1500_plus"];
const STATUSES = ["new", "contacted", "demo_scheduled", "demo_done", "won", "lost", "spam"];

// Someone from the public website asking for a demo. Only the superadmin sees these.
const demoRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: "" },
    instituteName: { type: String, trim: true, maxlength: 120, default: "" },
    city: { type: String, trim: true, maxlength: 60, default: "" },
    // A band, not an exact number: easier to answer, enough to size the lead.
    studentCount: { type: String, enum: STUDENT_BANDS, default: "" },
    currentTool: { type: String, trim: true, maxlength: 80, default: "" },
    preferredTime: { type: String, trim: true, maxlength: 60, default: "" },
    message: { type: String, trim: true, maxlength: 1000, default: "" },
    // Where it came from: page path, plus utm_source/medium when present.
    source: { type: String, trim: true, maxlength: 120, default: "website" },
    status: { type: String, enum: STATUSES, default: "new" },
    followUpAt: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { timestamps: true }
);

demoRequestSchema.index({ status: 1, createdAt: -1 });
demoRequestSchema.index({ phone: 1, createdAt: -1 });

module.exports = mongoose.model("DemoRequest", demoRequestSchema);
module.exports.STUDENT_BANDS = STUDENT_BANDS;
module.exports.STATUSES = STATUSES;
