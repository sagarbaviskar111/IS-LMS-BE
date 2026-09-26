const fs = require("fs");
const Material = require("../models/Material");
const Session = require("../models/Session");
const User = require("../models/User");
const { resolveType, DOCUMENT_MAX_SIZE } = require("../utils/upload");
const { uploadFile, deleteFile } = require("../utils/cloudinary");
const { withFileUrl } = require("../utils/fileUrlView");
const { uploadVideo, describeYoutubeError } = require("../utils/youtube");

const isAssigned = (req, batchId) =>
  (req.user.batches || []).some((b) => String(b) === String(batchId));

// YouTube's Data API gives each Google Cloud project a limited daily quota,
// and a single video upload eats a large share of it — enough real uploads
// in a day exhausts it and every upload after that fails with an opaque
// 502. Capping uploads per institute (not per teacher) before that happens
// gives a clear, actionable error instead.
const VIDEO_UPLOAD_DAILY_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const countRecentVideoUploads = (adminId) =>
  Material.countDocuments({
    admin: adminId,
    type: "video",
    createdAt: { $gte: new Date(Date.now() - DAY_MS) },
  });

exports.uploadMaterial = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "file is required" });
    }

    const { batch, title, description, session } = req.body;
    if (!batch || !title) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: "batch and title are required" });
    }
    if (!isAssigned(req, batch)) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ message: "You are not assigned to this batch" });
    }

    const type = resolveType(req.file.mimetype);

    // Multer's own limit is sized for the largest allowed upload (video);
    // a document over the stricter, much smaller cap has to be caught here.
    if (type === "document" && req.file.size > DOCUMENT_MAX_SIZE) {
      fs.unlink(req.file.path, () => {});
      return res.status(413).json({
        message: `Documents must be under ${Math.round(DOCUMENT_MAX_SIZE / (1024 * 1024))}MB`,
      });
    }

    // A session recording must be tied to a real session in this batch.
    // Study material (documents) may optionally link to one too, but it's not required.
    if (type === "video" && !session) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: "session is required for a video upload" });
    }

    let sessionId = null;
    if (session) {
      const sessionDoc = await Session.findOne({ _id: session, batch });
      if (!sessionDoc) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: "Invalid session for this batch" });
      }
      sessionId = sessionDoc._id;
    }

    let youtubeVideoId = null;
    let youtubeUrl = null;
    let cloudinaryPublicId = null;
    let cloudinaryResourceType = null;

    if (type === "video") {
      const adminUser = await User.findById(req.user.admin);
      if (!adminUser || !adminUser.youtube || !adminUser.youtube.connected) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          message: "Your institute hasn't connected a YouTube account yet — ask your admin to connect one first.",
        });
      }

      const recentUploads = await countRecentVideoUploads(req.user.admin);
      if (recentUploads >= VIDEO_UPLOAD_DAILY_LIMIT) {
        fs.unlink(req.file.path, () => {});
        return res.status(429).json({
          message: `Your institute has uploaded ${VIDEO_UPLOAD_DAILY_LIMIT} videos in the last 24 hours — that's the daily limit (YouTube's own upload quota runs out around there). Try again later once some of today's uploads roll past 24 hours old.`,
        });
      }

      try {
        const result = await uploadVideo(req.user.admin, req.file.path, { title, description });
        youtubeVideoId = result.videoId;
        youtubeUrl = `https://www.youtube.com/watch?v=${result.videoId}`;
      } catch (err) {
        fs.unlink(req.file.path, () => {});
        const { reason, message } = describeYoutubeError(err);
        console.error(
          `[youtube-upload] failed (${reason}) for admin ${req.user.admin}:`,
          err?.response?.data?.error || err?.message || err
        );
        return res.status(502).json({ message });
      }
    } else {
      try {
        const result = await uploadFile(req.file.path, { folder: `materials/${batch}`, resourceType: "raw" });
        cloudinaryPublicId = result.public_id;
        cloudinaryResourceType = result.resource_type;
      } catch (err) {
        fs.unlink(req.file.path, () => {});
        return res.status(502).json({ message: "Upload failed — please try again" });
      }
    }

    // The file now lives on Cloudinary/YouTube — no need to keep the local temp copy.
    fs.unlink(req.file.path, () => {});

    const material = await Material.create({
      batch,
      admin: req.user.admin,
      uploadedBy: req.user._id,
      session: sessionId,
      type,
      title,
      description,
      fileName: req.file.originalname,
      cloudinaryPublicId,
      cloudinaryResourceType,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      youtubeVideoId,
      youtubeUrl,
    });

    res.status(201).json({ material: withFileUrl(material) });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ message: "Server error" });
  }
};

exports.listMaterials = async (req, res) => {
  try {
    const { batch } = req.query;
    if (!batch) return res.status(400).json({ message: "batch is required" });
    if (!isAssigned(req, batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const materials = await Material.find({ batch })
      .populate("session", "topic date startTime endTime")
      .sort({ createdAt: -1 });
    res.json({ materials: materials.map(withFileUrl) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteMaterial = async (req, res) => {
  try {
    const material = await Material.findById(req.params.id);
    if (!material) return res.status(404).json({ message: "Material not found" });
    if (!isAssigned(req, material.batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await material.deleteOne();
    if (material.cloudinaryPublicId) {
      await deleteFile(material.cloudinaryPublicId, material.cloudinaryResourceType);
    }

    res.json({ message: "Material deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
