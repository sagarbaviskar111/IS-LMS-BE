const mongoose = require("mongoose");

const jobSchema = new mongoose.Schema(
  {
    // Coaching class (tenant) this job posting belongs to.
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    salary: { type: String, trim: true },
    location: { type: String, trim: true },
    // "all" — every student under this admin can see it.
    // "batch" — only students in `batch` can see it.
    visibility: { type: String, enum: ["all", "batch"], default: "all" },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    // "link" — student clicks straight through to the company's own apply page.
    // "interest" — student just registers interest; the admin applies for
    // them on their own end, using the interested-students list.
    applicationMode: { type: String, enum: ["link", "interest"], required: true },
    applyLink: { type: String, trim: true, default: null },
    status: { type: String, enum: ["open", "closed"], default: "open" },
  },
  { timestamps: true }
);

jobSchema.index({ admin: 1, createdAt: -1 });

module.exports = mongoose.model("Job", jobSchema);
