const mongoose = require("mongoose");

// One text slot placed on the certificate image. Positions and sizes are
// percentages of the image, so the layout survives any image resolution.
const fieldSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      enum: ["student_name", "certificate_no", "course", "date", "grade", "batch", "institute_name", "custom"],
      required: true,
    },
    // Fixed text, only for key = "custom".
    text: { type: String, trim: true, maxlength: 200, default: "" },
    x: { type: Number, min: 0, max: 100, default: 50 }, // anchor point, % of width
    y: { type: Number, min: 0, max: 100, default: 50 }, // vertical centre, % of height
    fontSize: { type: Number, min: 0.5, max: 20, default: 3 }, // % of image width
    maxWidth: { type: Number, min: 0, max: 100, default: 0 }, // % of width, 0 = no limit (text shrinks to fit)
    color: { type: String, default: "#111111" },
    align: { type: String, enum: ["left", "center", "right"], default: "center" },
    font: { type: String, enum: ["helvetica", "times", "courier", "unicode"], default: "helvetica" },
    bold: { type: Boolean, default: false },
    italic: { type: Boolean, default: false },
    transform: { type: String, enum: ["none", "upper", "title"], default: "none" },
  },
  { _id: true }
);

const certificateTemplateSchema = new mongoose.Schema(
  {
    // Coaching class (tenant) that owns the template.
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    image: {
      cloudinaryPublicId: { type: String, required: true },
      cloudinaryResourceType: { type: String, default: "image" },
      width: { type: Number, required: true },
      height: { type: Number, required: true },
    },
    fields: { type: [fieldSchema], default: [] },
    qr: {
      enabled: { type: Boolean, default: true },
      x: { type: Number, min: 0, max: 100, default: 90 }, // centre, % of width
      y: { type: Number, min: 0, max: 100, default: 85 }, // centre, % of height
      size: { type: Number, min: 3, max: 30, default: 9 }, // % of width
    },
    numbering: {
      prefix: { type: String, trim: true, maxlength: 20, default: "CERT" },
      includeYear: { type: Boolean, default: true },
      padding: { type: Number, min: 1, max: 8, default: 4 },
      counter: { type: Number, default: 0 }, // last number handed out
    },
    // A template that already issued certificates is archived rather than
    // deleted, so those certificates stay re-downloadable and verifiable.
    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

certificateTemplateSchema.index({ admin: 1, archived: 1, createdAt: -1 });

module.exports = mongoose.model("CertificateTemplate", certificateTemplateSchema);
