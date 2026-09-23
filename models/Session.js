const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema(
  {
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    topic: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    // 24-hour "HH:mm", zero-padded so lexicographic comparison works for ordering/validation.
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    notes: { type: String, trim: true },
    meetingLink: { type: String, trim: true },
  },
  { timestamps: true }
);

sessionSchema.index({ batch: 1, date: 1 });

module.exports = mongoose.model("Session", sessionSchema);
