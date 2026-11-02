const mongoose = require("mongoose");

// What a sub-admin changed, so the admin can see who did what. Only successful
// changes (not reads) are kept, and only for 90 days.
const subadminActivitySchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    subadmin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    module: { type: String, default: null },
    method: { type: String, required: true },
    // The request path with ids replaced by ":id".
    path: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 },
  },
  { versionKey: false }
);

subadminActivitySchema.index({ admin: 1, createdAt: -1 });
subadminActivitySchema.index({ subadmin: 1, createdAt: -1 });

module.exports = mongoose.model("SubadminActivity", subadminActivitySchema);
