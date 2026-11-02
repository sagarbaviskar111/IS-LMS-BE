const mongoose = require("mongoose");

// One issued certificate. The PDF itself is never stored: it is drawn on
// demand from the template plus the `values` snapshot below, so a re-download
// always matches what was issued even if the student is later renamed.
const certificateSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: "CertificateTemplate", required: true },
    // null for people who only appear in an uploaded sheet and have no account.
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    recipient: {
      email: { type: String, trim: true, lowercase: true, default: "" },
      phone: { type: String, trim: true, default: "" },
    },
    certificateNo: { type: String, required: true, trim: true },
    // Public, unguessable id used in the QR / verification URL.
    verifyCode: { type: String, required: true, unique: true },
    values: {
      student_name: { type: String, default: "" },
      course: { type: String, default: "" },
      batch: { type: String, default: "" },
      grade: { type: String, default: "" },
      institute_name: { type: String, default: "" },
      date: { type: Date, required: true },
    },
    // The group this certificate was issued in, if the admin made one.
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "CertificateBatch", default: null },
    // false = the QR code is left off this certificate's PDF (the verify link still works).
    qrEnabled: { type: Boolean, default: true },
    // Emailing the PDF to the recipient.
    emailStatus: {
      sentAt: { type: Date, default: null },
      to: { type: String, default: "" },
      error: { type: String, default: "" },
    },
    status: { type: String, enum: ["active", "revoked"], default: "active" },
    revokedReason: { type: String, trim: true, maxlength: 300, default: "" },
    revokedAt: { type: Date, default: null },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

certificateSchema.index({ admin: 1, certificateNo: 1 }, { unique: true });
certificateSchema.index({ admin: 1, createdAt: -1 });
certificateSchema.index({ student: 1, status: 1 });
certificateSchema.index({ batch: 1 });

module.exports = mongoose.model("Certificate", certificateSchema);
