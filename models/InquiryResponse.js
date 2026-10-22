const mongoose = require("mongoose");

const inquiryResponseSchema = new mongoose.Schema(
  {
    form: { type: mongoose.Schema.Types.ObjectId, ref: "InquiryForm", required: true, index: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // questionId -> string (text/choice/date/time), number (scale), string[]
    // (checkboxes), or { [row]: string | string[] } (grids).
    answers: { type: mongoose.Schema.Types.Mixed, default: {} },
    // The Lead this response became (auto on a "yes" lead answer, or added by
    // hand later). leadAddedBy is null when it was automatic.
    lead: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    leadAddedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    leadAddedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

inquiryResponseSchema.index({ form: 1, createdAt: -1 });

module.exports = mongoose.model("InquiryResponse", inquiryResponseSchema);
