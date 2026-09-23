const mongoose = require("mongoose");

const submissionSchema = new mongoose.Schema(
  {
    exam: { type: mongoose.Schema.Types.ObjectId, ref: "Exam", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
    answers: [
      {
        question: { type: mongoose.Schema.Types.ObjectId, required: true },
        selectedOptionIndex: { type: Number, required: true },
      },
    ],
    // Snapshotted at submission time — server-graded, never trust a client-sent score.
    score: { type: Number, required: true },
    totalMarks: { type: Number, required: true },
  },
  { timestamps: true }
);

submissionSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("Submission", submissionSchema);
