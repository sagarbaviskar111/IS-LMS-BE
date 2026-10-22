const mongoose = require("mongoose");

// Everything a student submitted through a course's registration link.
// Files live on disk under uploads/registrations and are only ever served
// to the owning admin (never publicly).
const fileSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    mimetype: { type: String, default: "" },
    originalName: { type: String, default: "" },
    // What this document is (Aadhaar, PAN...) — set for ID proofs.
    docType: { type: String, trim: true, maxlength: 40, default: "" },
  },
  { _id: false }
);

const courseRegistrationSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Basic details as entered.
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },
    dateOfBirth: { type: Date, default: null },
    address: { type: String, trim: true, maxlength: 500, default: "" },

    // Verification.
    idType: { type: String, trim: true, maxlength: 40, default: "" },
    idProofs: { type: [fileSchema], default: [] },
    selfie: { type: fileSchema, required: true },
    signature: { type: fileSchema, required: true },
    termsAcceptedAt: { type: Date, required: true },

    // Payment chosen at registration.
    plan: { type: String, enum: ["one_time", "installment"], required: true },
    planTotal: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

courseRegistrationSchema.index({ course: 1, createdAt: -1 });

module.exports = mongoose.model("CourseRegistration", courseRegistrationSchema);
