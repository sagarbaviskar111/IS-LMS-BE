const mongoose = require("mongoose");

// A named group of certificates issued together (e.g. "Web Dev – Oct 2026 pass-outs"),
// so the whole group can be found, downloaded or emailed in one go.
const certificateBatchSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    template: { type: mongoose.Schema.Types.ObjectId, ref: "CertificateTemplate", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

certificateBatchSchema.index({ admin: 1, createdAt: -1 });

module.exports = mongoose.model("CertificateBatch", certificateBatchSchema);
