const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const ROLES = ["superadmin", "admin", "student", "teacher", "telecaller"];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    role: { type: String, enum: ROLES, required: true },
    phone: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    // True only for self-registered accounts awaiting their first admin approval.
    // Separate from isActive so deactivating an already-approved user later
    // doesn't put them back in the pending-approval queue.
    pending: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Coaching class (tenant) this user belongs to — the admin who owns it.
    // Set for student/teacher/telecaller, null for superadmin/admin.
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Per-role join codes for an admin's coaching class, used for self-registration.
    // The code itself determines the role granted — never trust a role field from the client.
    studentInviteCode: { type: String, unique: true, sparse: true },
    teacherInviteCode: { type: String, unique: true, sparse: true },
    telecallerInviteCode: { type: String, unique: true, sparse: true },
    // Students belong to exactly one batch.
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    // Teachers can be assigned to multiple batches.
    batches: [{ type: mongoose.Schema.Types.ObjectId, ref: "Batch" }],

    // --- Payment (students only) ---
    // Amount charged each payment cycle, decided at registration by the
    // telecaller/admin (or defaulted from the batch) and editable by admin.
    installmentAmount: { type: Number, default: 0, min: 0 },
    // Running balance currently owed. Charged installmentAmount at each cycle
    // rollover, reduced as payments are recorded.
    balanceDue: { type: Number, default: 0, min: 0 },
    // When the next cycle's installment is charged / the current balance is due.
    nextDueDate: { type: Date, default: null },
    // Admin-granted extension — if set and in the future, deactivation waits
    // for this date instead of nextDueDate.
    paymentGraceUntil: { type: Date, default: null },
    // True when isActive was set to false by the payment-cycle job specifically
    // (as opposed to an admin manually deactivating the account), so login can
    // show a payment-specific message and admin UI can offer "reactivate".
    deactivatedForPayment: { type: Boolean, default: false },
    // True for a lead's self-registration that's created the account but is
    // still waiting on the first online payment before it can be used.
    paymentPending: { type: Boolean, default: false },
    // Custom message shown on the login screen when an admin manually
    // deactivates this account (e.g. "Dues pending, contact the office").
    // Falls back to a generic default at login time when unset. Cleared
    // automatically on reactivation.
    deactivationMessage: { type: String, default: null, trim: true },
    // Blocks access to session recordings (not login) for a date range.
    // recordingBlockTo left null blocks that session's date and every date
    // after it — used once a student's paid period lapses, until the admin
    // clears the block after payment. Both null means no block.
    recordingBlockFrom: { type: Date, default: null },
    recordingBlockTo: { type: Date, default: null },
    // The Razorpay order created for this student's pending registration
    // payment. Verification must match against this exact order id — never
    // trust a client-submitted order id on its own, or a signature from any
    // other successful payment on the account could be replayed here.
    pendingRazorpayOrderId: { type: String, default: null },

    // --- YouTube integration (admin only) ---
    // Each coaching class connects its own YouTube channel; teachers under
    // that admin then upload session recordings straight to it as unlisted
    // videos. The refresh token is encrypted at rest and never serialized.
    // Each institute also brings its own Google Cloud OAuth app (own
    // googleClientId/googleClientSecret) rather than sharing one across every
    // institute — the YouTube Data API's upload quota is allocated per
    // project, not per channel, so a shared app would mean every institute's
    // teachers draw from the same small daily upload allowance.
    youtube: {
      connected: { type: Boolean, default: false },
      googleClientId: { type: String, default: null },
      googleClientSecret: { type: String, default: null, select: false },
      channelId: { type: String, default: null },
      channelTitle: { type: String, default: null },
      refreshToken: { type: String, default: null, select: false },
      connectedAt: { type: Date, default: null },
    },

    // --- Institute branding (admin only) ---
    // The admin's own `name` doubles as the coaching class's display name
    // (already used that way for invite-info/lead-info responses).
    // instituteSlug is the URL segment every user under this admin logs in
    // through, e.g. /clinidea-education/dashboard/... — generated from name
    // at creation, editable by the admin afterward.
    instituteSlug: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    brandColor: { type: String, default: null },
    logo: {
      cloudinaryPublicId: { type: String, default: null },
      cloudinaryResourceType: { type: String, default: null },
    },
  },
  { timestamps: true }
);

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.password;
    if (ret.youtube) {
      delete ret.youtube.refreshToken;
      delete ret.youtube.googleClientSecret;
    }
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
module.exports.ROLES = ROLES;
