const mongoose = require("mongoose");

const installmentSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, maxlength: 60, default: "" },
    amount: { type: Number, required: true, min: 0 },
    // Due this many days after the student joins (0 = at joining).
    dueAfterDays: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const courseSchema = new mongoose.Schema(
  {
    // Coaching class (tenant) this course belongs to.
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 3000, default: "" },
    level: { type: String, enum: ["beginner", "intermediate", "advanced", "all"], default: "all" },
    language: { type: String, trim: true, maxlength: 40, default: "" },
    mode: { type: String, enum: ["online", "offline", "hybrid"], default: "online" },
    durationValue: { type: Number, default: 0, min: 0 },
    durationUnit: { type: String, enum: ["days", "weeks", "months"], default: "months" },
    prerequisites: { type: String, trim: true, maxlength: 500, default: "" },

    // The admin decides how students may pay: all at once, in installments, or either.
    oneTimeEnabled: { type: Boolean, default: true },
    oneTimeAmount: { type: Number, default: 0, min: 0 },
    installmentEnabled: { type: Boolean, default: false },
    installments: [installmentSchema],
    // Extra charge the admin adds for choosing installments; payable on top of them.
    installmentCharge: { type: Number, default: 0, min: 0 },

    // Plain text, pasted in by the admin as-is (line breaks kept).
    syllabus: { type: String, trim: true, maxlength: 30000, default: "" },
    // Terms shown to a student during registration; blank = the standard text.
    terms: { type: String, trim: true, maxlength: 20000, default: "" },
    // Public self-registration link for this course: /enroll/<token>.
    registrationToken: { type: String, unique: true, sparse: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

courseSchema.index({ admin: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Course", courseSchema);
