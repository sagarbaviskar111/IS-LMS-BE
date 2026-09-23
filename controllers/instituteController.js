const fs = require("fs");
const User = require("../models/User");
const { uploadFile, deleteFile, resolveResourceType, getFileUrl } = require("../utils/cloudinary");
const { slugify, RESERVED_SLUGS } = require("../utils/slug");
const { shapeInstitute } = require("../utils/institute");

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Public — powers the branded /<slug>/login and /<slug>/signup pages before
// anyone is authenticated.
exports.getPublicInstitute = async (req, res) => {
  try {
    const slug = (req.params.slug || "").toLowerCase().trim();
    if (!slug) return res.status(400).json({ message: "slug is required" });

    const admin = await User.findOne({ instituteSlug: slug, role: "admin", isActive: true }).select(
      "name instituteSlug brandColor logo"
    );
    if (!admin) return res.status(404).json({ message: "Institute not found" });

    res.json({ institute: shapeInstitute(admin) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Unlike shapeInstitute (used for public/branding display), this always
// returns the admin's own settings even before they've set a slug — the
// settings page needs to show "not set up yet" and let them pick one.
const ownBranding = (admin) => ({
  name: admin.name,
  instituteSlug: admin.instituteSlug || null,
  brandColor: admin.brandColor || null,
  logoUrl: admin.logo?.cloudinaryPublicId ? getFileUrl(admin.logo.cloudinaryPublicId, admin.logo.cloudinaryResourceType) : null,
});

exports.getBranding = async (req, res) => {
  res.json({ institute: ownBranding(req.user) });
};

exports.updateBranding = async (req, res) => {
  try {
    const admin = req.user;
    const { instituteSlug, brandColor } = req.body;

    if (instituteSlug !== undefined) {
      const clean = slugify(instituteSlug);
      if (!clean) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: "Invalid URL — use letters, numbers and hyphens" });
      }
      if (clean !== admin.instituteSlug) {
        if (RESERVED_SLUGS.has(clean)) {
          if (req.file) fs.unlink(req.file.path, () => {});
          return res.status(409).json({ message: "That URL is reserved — try another" });
        }
        const taken = await User.findOne({ instituteSlug: clean, _id: { $ne: admin._id } });
        if (taken) {
          if (req.file) fs.unlink(req.file.path, () => {});
          return res.status(409).json({ message: "That URL is already taken — try another" });
        }
        admin.instituteSlug = clean;
      }
    }

    if (brandColor !== undefined) {
      if (brandColor && !HEX_COLOR.test(brandColor)) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: "brandColor must be a hex color like #4f46e5" });
      }
      admin.brandColor = brandColor || null;
    }

    if (req.file) {
      let result;
      try {
        const resourceType = resolveResourceType(req.file.mimetype);
        result = await uploadFile(req.file.path, { folder: `institute-logos/${admin._id}`, resourceType });
      } catch (err) {
        fs.unlink(req.file.path, () => {});
        return res.status(502).json({ message: "Logo upload failed — please try again" });
      }
      fs.unlink(req.file.path, () => {});

      const oldPublicId = admin.logo?.cloudinaryPublicId;
      const oldResourceType = admin.logo?.cloudinaryResourceType;
      admin.logo = { cloudinaryPublicId: result.public_id, cloudinaryResourceType: result.resource_type };
      if (oldPublicId) await deleteFile(oldPublicId, oldResourceType);
    }

    await admin.save();
    res.json({ institute: ownBranding(admin) });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ message: "Server error" });
  }
};
