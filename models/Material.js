const mongoose = require("mongoose");

const materialSchema = new mongoose.Schema(
  {
    batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    session: { type: mongoose.Schema.Types.ObjectId, ref: "Session", default: null },
    type: { type: String, enum: ["document", "video"], required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    fileName: { type: String, required: true },
    // Documents live on Cloudinary; a YouTube-hosted video has neither.
    // fileUrl is never persisted — the stored PDF/ZIP delivery restriction
    // means it must be a freshly-signed download URL, computed per response
    // (see utils/fileUrlView.js) rather than a static Cloudinary secure_url.
    cloudinaryPublicId: {
      type: String,
      default: null,
      required: function () {
        return !this.youtubeVideoId;
      },
    },
    cloudinaryResourceType: { type: String, default: null },
    fileSize: { type: Number, required: true },
    mimeType: { type: String, required: true },
    // Session recordings are uploaded straight to the institute's YouTube
    // channel as unlisted videos instead of being stored as a document.
    youtubeVideoId: { type: String, default: null },
    youtubeUrl: { type: String, default: null },
  },
  { timestamps: true }
);

materialSchema.index({ batch: 1 });

module.exports = mongoose.model("Material", materialSchema);
