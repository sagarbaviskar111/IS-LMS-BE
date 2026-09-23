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
  },
  { timestamps: true }
);

assignmentSubmissionSchema.index({ assignment: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("AssignmentSubmission", assignmentSubmissionSchema);
