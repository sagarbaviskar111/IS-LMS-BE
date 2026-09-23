const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    options: {
      type: [{ type: String, required: true, trim: true }],
      validate: {
        validator: (arr) => arr.length >= 2 && arr.length <= 6,
        message: "A question needs between 2 and 6 options",
      },
    },
    correctOptionIndex: { type: Number, required: true, min: 0 },
    marks: { type: Number, default: 1, min: 1 },
  },
  { timestamps: true }
);

const examSchema = new mongoose.Schema(
  {
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    // draft: teacher is building it, invisible to students.
    // published: visible to students, open for submissions.
    // closed: no more submissions; results can then be announced.
    status: { type: String, enum: ["draft", "published", "closed"], default: "draft" },
    resultsAnnounced: { type: Boolean, default: false },
    questions: [questionSchema],
  },
  { timestamps: true }
);

examSchema.index({ batch: 1 });

module.exports = mongoose.model("Exam", examSchema);
