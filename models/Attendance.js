const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
  {
    session: { type: mongoose.Schema.Types.ObjectId, ref: "Session", required: true, unique: true },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    records: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        status: { type: String, enum: ["present", "absent"], required: true },
      },
    ],
  },
  { timestamps: true }
);

attendanceSchema.index({ batch: 1 });

module.exports = mongoose.model("Attendance", attendanceSchema);
