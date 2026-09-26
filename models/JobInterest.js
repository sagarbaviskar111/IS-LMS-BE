const mongoose = require("mongoose");

// One row per student who clicked "I'm interested" on an admin-apply job —
// the admin applies to the company on the student's behalf, using this list.
const jobInterestSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

jobInterestSchema.index({ job: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("JobInterest", jobInterestSchema);
