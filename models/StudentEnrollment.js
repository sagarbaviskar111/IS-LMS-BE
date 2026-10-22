const mongoose = require("mongoose");

// A student the admin registered by hand (name, email, phone, course). The
// student stays deactivated until they finish the rest of their registration
// through a private link made for them alone.
const studentEnrollmentSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },

    // The private link: one per student, with an expiry the admin chooses.
    // Making a new link replaces the token, so older links stop working.
    token: { type: String, unique: true, sparse: true },
    expiresAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },

    // Fees the admin already collected (cash / UPI) when registering.
    // "unpaid" means the student pays inside the registration flow.
    paidStatus: { type: String, enum: ["unpaid", "first_installment", "full"], default: "unpaid" },
    plan: { type: String, enum: ["one_time", "installment", null], default: null },
    planTotal: { type: Number, default: 0, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    paymentMethod: { type: String, trim: true, maxlength: 20, default: "" },
    // Days from joining until the next installment falls due (0 = none).
    nextDays: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StudentEnrollment", studentEnrollmentSchema);
