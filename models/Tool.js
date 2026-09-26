const mongoose = require("mongoose");

const toolSchema = new mongoose.Schema(
  {
    // Coaching class (tenant) this tool belongs to.
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

toolSchema.index({ admin: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Tool", toolSchema);
