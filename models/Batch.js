const mongoose = require("mongoose");

const batchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    // Coaching class (tenant) this batch belongs to.
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // The course this batch teaches; the course defines fees and syllabus.
    // Optional only for batches created before courses existed.
    course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", default: null },
    mode: { type: String, enum: ["online", "offline", "hybrid"], default: "online" },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    maxStudents: { type: Number, default: 0, min: 0 }, // 0 = no limit
    // Fallback fee/cycle applied to a student when they're first assigned to this
    // batch and don't already have payment terms set (e.g. from a lead's fee).
    defaultFee: { type: Number, default: 0, min: 0 },
    // How many days between installment due dates for students in this batch.
    paymentCycleDays: { type: Number, default: 30, min: 1 },
  },
  { timestamps: true }
);

batchSchema.index({ admin: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Batch", batchSchema);
