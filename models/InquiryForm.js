const mongoose = require("mongoose");

const QUESTION_TYPES = [
  "short_text",
  "paragraph",
  "multiple_choice",
  "checkboxes",
  "dropdown",
  "linear_scale",
  "date",
  "time",
  "multiple_choice_grid",
  "checkbox_grid",
  // Contact questions with strict server-side validation.
  "name",
  "phone",
  "email",
  // Always-required Yes/No. "Yes" puts the respondent straight into the
  // institute's lead list (needs a name and a phone question on the form).
  "lead",
];

const questionSchema = new mongoose.Schema(
  {
    // Client-generated, stable across edits so existing responses keep
    // pointing at the right question. Restricted to [A-Za-z0-9_] because it
    // becomes a Mongo field name under `answers.` in response filters.
    id: { type: String, required: true, match: /^[A-Za-z0-9_]{1,40}$/ },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    title: { type: String, required: true, trim: true, maxlength: 500 },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    required: { type: Boolean, default: false },
    // multiple_choice / checkboxes / dropdown
    options: [{ type: String, trim: true, maxlength: 300 }],
    // linear_scale
    scaleMin: { type: Number, default: 1 },
    scaleMax: { type: Number, default: 5 },
    scaleMinLabel: { type: String, trim: true, default: "" },
    scaleMaxLabel: { type: String, trim: true, default: "" },
    // multiple_choice_grid / checkbox_grid
    rows: [{ type: String, trim: true, maxlength: 300 }],
    columns: [{ type: String, trim: true, maxlength: 300 }],
  },
  { _id: false }
);

const inquiryFormSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Short random id used in the public URL: /<institute>/inquiry/<subject>-<publicId>
    publicId: { type: String, required: true, unique: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: "" },
    questions: [questionSchema],
    // When false the public link shows "not accepting responses".
    isActive: { type: Boolean, default: true },
    responseCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("InquiryForm", inquiryFormSchema);
module.exports.QUESTION_TYPES = QUESTION_TYPES;
