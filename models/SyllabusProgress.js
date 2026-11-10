const mongoose = require("mongoose");

// One row = one syllabus topic that a batch has finished. Progress belongs to a
// BATCH, not the course: two batches of the same course move at their own pace.
const syllabusProgressSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
    topicId: { type: mongoose.Schema.Types.ObjectId, required: true },
    completedAt: { type: Date, default: Date.now },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

syllabusProgressSchema.index({ batch: 1, topicId: 1 }, { unique: true });

module.exports = mongoose.model("SyllabusProgress", syllabusProgressSchema);
