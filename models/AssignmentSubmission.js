const mongoose = require("mongoose");

const assignmentSubmissionSchema = new mongoose.Schema(
  {
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
    fileName: { type: String, required: true },
    // fileUrl is never persisted — see utils/fileUrlView.js.
    cloudinaryPublicId: { type: String, required: true },
    cloudinaryResourceType: { type: String, required: true },
    fileSize: { type: Number, required: true },
    mimeType: { type: String, required: true },
    // Bumped on resubmission (before the due date) — not the same as createdAt.
    submittedAt: { type: Date, default: Date.now },
    // Teacher's review: points awarded (null until graded) and a sanitized
    // rich-text comment (see utils/richText.js).
    points: { type: Number, default: null, min: 0 },
    review: { type: String, default: "" },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // The teacher's verdict: "approved" (done), "resubmit" (student must submit
    // again - allowed until resubmitUntil even if the due date has passed), or
    // "rejected" (not accepted, and no further attempts). "" = not decided yet.
    decision: { type: String, enum: ["", "approved", "resubmit", "rejected"], default: "" },
    resubmitUntil: { type: Date, default: null },
    // Earlier attempts, archived when the student submits again.
    history: {
      type: [
        {
          fileName: String,
          submittedAt: Date,
          decision: String,
          points: { type: Number, default: null },
          review: { type: String, default: "" },
          reviewedAt: Date,
        },
      ],
      default: [],
    },
    // The teacher's verdict: "approved" (done), "resubmit" (student must submit
    // again — allowed until resubmitUntil even if the due date has passed), or
    // "rejected" (not accepted, and no further attempts). "" = not decided yet.
    decision: { type: String, enum: ["", "approved", "resubmit", "rejected"], default: "" },
    resubmitUntil: { type: Date, default: null },
    // Earlier attempts, archived when the student submits again.
    history: {
      type: [
        {
          fileName: String,
          submittedAt: Date,
          decision: String,
          points: { type: Number, default: null },
          review: { type: String, default: "" },
          reviewedAt: Date,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

assignmentSubmissionSchema.index({ assignment: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("AssignmentSubmission", assignmentSubmissionSchema);
