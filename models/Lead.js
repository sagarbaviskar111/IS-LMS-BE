const mongoose = require("mongoose");

const CALL_RESPONSES = ["no_answer", "call_back_later", "interested", "not_interested", "wrong_number"];

const callLogSchema = new mongoose.Schema(
  {
    calledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    response: { type: String, enum: CALL_RESPONSES, required: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

const leadSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    notes: { type: String, trim: true },
    assignedTelecaller: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: ["new", "contacted", "interested", "not_interested", "converted", "lost"],
      default: "new",
    },
    convertedStudent: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Who registered the student: the telecaller, or the admin (direct registration).
    // Null means the prospect self-registered via the generated link.
    convertedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // One-time token for the "generate registration link" flow — cleared/checked via convertedStudent.
    registrationToken: { type: String, unique: true, sparse: true },
    // Fee amount the telecaller/admin decided this prospect should pay, set
    // before generating the registration link (or a direct registration).
    feeAmount: { type: Number, default: 0, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    callLogs: [callLogSchema],
    // Where this lead came from — "webhook" for anything ingested via
    // POST /api/leads/webhook/:apiKey (a connected Google Sheet, another
    // website, Zapier, etc.), with sourceLabel holding whatever the sender
    // called itself so the admin can tell integrations apart.
    source: { type: String, enum: ["manual", "webhook"], default: "manual" },
    sourceLabel: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

leadSchema.index({ admin: 1 });
leadSchema.index({ admin: 1, assignedTelecaller: 1 });

module.exports = mongoose.model("Lead", leadSchema);
module.exports.CALL_RESPONSES = CALL_RESPONSES;
