const mongoose = require("mongoose");

const assignmentSchema = new mongoose.Schema(
  {
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    // The hard cutoff — students can no longer submit once this passes.
    // Editable by the teacher after creation.
    dueDate: { type: Date, required: true },
    // Optional reference file the teacher attaches (e.g. the question sheet).
    // fileUrl is never persisted — see utils/fileUrlView.js.
    attachment: {
      fileName: { type: String, default: null },
      cloudinaryPublicId: { type: String, default: null },
      cloudinaryResourceType: { type: String, default: null },
      fileSize: { type: Number, default: null },
      mimeType: { type: String, default: null },
    },
  },
  { timestamps: true }
);

assignmentSchema.index({ batch: 1 });

module.exports = mongoose.model("Assignment", assignmentSchema);
