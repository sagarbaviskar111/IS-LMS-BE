const mongoose = require("mongoose");

const studentGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Coaching class (tenant) this group belongs to.
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

studentGroupSchema.index({ admin: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("StudentGroup", studentGroupSchema);
