const fs = require("fs");
const PortfolioUser = require("../models/PortfolioUser");
const generatePortfolioToken = require("../utils/generatePortfolioToken");
const { generatePortfolioSlug } = require("../utils/portfolioSlug");
const { uploadFile, deleteFile, resolveResourceType, getFileUrl } = require("../utils/cloudinary");

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  // See the matching comment in authController.js — lets the cookie set by
  // the API subdomain be read on the frontend's own domain too.
  domain: process.env.COOKIE_DOMAIN || undefined,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// PATCH /me only ever replaces these profile-content fields — email,
// password, dob and slug are never editable through it (no account-recovery
// flow exists yet, so keep this endpoint narrowly scoped).
const UPDATABLE_FIELDS = [
  "name",
  "headline",
  "bio",
  "phone",
  "location",
  "socialLinks",
  "education",
  "experience",
  "projects",
  "skills",
  "achievements",
];

const shapePortfolio = (doc, { includePrivate } = {}) => ({
  slug: doc.slug,
  name: doc.name,
  headline: doc.headline || "",
  bio: doc.bio || "",
  phone: doc.phone || "",
  location: doc.location || "",
  profilePictureUrl: doc.profilePicture?.cloudinaryPublicId
    ? getFileUrl(doc.profilePicture.cloudinaryPublicId, doc.profilePicture.cloudinaryResourceType)
    : null,
  backgroundImageUrl: doc.backgroundImage?.cloudinaryPublicId
    ? getFileUrl(doc.backgroundImage.cloudinaryPublicId, doc.backgroundImage.cloudinaryResourceType)
    : null,
  socialLinks: doc.socialLinks || {},
  education: doc.education || [],
  experience: doc.experience || [],
  projects: doc.projects || [],
  skills: doc.skills || [],
  achievements: doc.achievements || [],
  ...(includePrivate ? { email: doc.email, dob: doc.dob } : {}),
});

exports.register = async (req, res) => {
  try {
    const { name, email, password, dob, headline, bio, phone, location } = req.body;

    if (!name || !email || !password || !dob) {
      return res.status(400).json({ message: "name, email, password and dob are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "password must be at least 6 characters" });
    }

    const existing = await PortfolioUser.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: "An account with this email already exists" });
    }

    const slug = await generatePortfolioSlug(name, dob);

    const portfolioUser = await PortfolioUser.create({
      name,
      email,
      password,
      dob,
      slug,
      headline,
      bio,
      phone,
      location,
    });

    const token = generatePortfolioToken(portfolioUser);
    res.cookie("portfolio_token", token, cookieOptions);
    res.status(201).json({ portfolio: shapePortfolio(portfolioUser, { includePrivate: true }) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const portfolioUser = await PortfolioUser.findOne({ email: email.toLowerCase() }).select("+password");
    if (!portfolioUser) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await portfolioUser.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generatePortfolioToken(portfolioUser);
    res.cookie("portfolio_token", token, cookieOptions);
    res.json({ portfolio: shapePortfolio(portfolioUser, { includePrivate: true }) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.logout = (req, res) => {
  res.clearCookie("portfolio_token", { ...cookieOptions, maxAge: undefined });
  res.json({ message: "Logged out" });
};

exports.me = async (req, res) => {
  res.json({ portfolio: shapePortfolio(req.portfolioUser, { includePrivate: true }) });
};

exports.updateMe = async (req, res) => {
  try {
    for (const field of UPDATABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        req.portfolioUser[field] = req.body[field];
      }
    }
    await req.portfolioUser.save();
    res.json({ portfolio: shapePortfolio(req.portfolioUser, { includePrivate: true }) });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.uploadProfilePicture = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "image is required" });
    }

    let result;
    try {
      const resourceType = resolveResourceType(req.file.mimetype);
      result = await uploadFile(req.file.path, {
        folder: `portfolio/${req.portfolioUser._id}/profile`,
        resourceType,
      });
    } catch (err) {
      fs.unlink(req.file.path, () => {});
      return res.status(502).json({ message: "Image upload failed — please try again" });
    }
    fs.unlink(req.file.path, () => {});

    const oldPublicId = req.portfolioUser.profilePicture?.cloudinaryPublicId;
    const oldResourceType = req.portfolioUser.profilePicture?.cloudinaryResourceType;
    req.portfolioUser.profilePicture = {
      cloudinaryPublicId: result.public_id,
      cloudinaryResourceType: result.resource_type,
    };
    await req.portfolioUser.save();
    if (oldPublicId) await deleteFile(oldPublicId, oldResourceType);

    res.json({ portfolio: shapePortfolio(req.portfolioUser, { includePrivate: true }) });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ message: "Server error" });
  }
};

exports.uploadBackgroundImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "image is required" });
    }

    let result;
    try {
      const resourceType = resolveResourceType(req.file.mimetype);
      result = await uploadFile(req.file.path, {
        folder: `portfolio/${req.portfolioUser._id}/background`,
        resourceType,
      });
    } catch (err) {
      fs.unlink(req.file.path, () => {});
      return res.status(502).json({ message: "Image upload failed — please try again" });
    }
    fs.unlink(req.file.path, () => {});

    const oldPublicId = req.portfolioUser.backgroundImage?.cloudinaryPublicId;
    const oldResourceType = req.portfolioUser.backgroundImage?.cloudinaryResourceType;
    req.portfolioUser.backgroundImage = {
      cloudinaryPublicId: result.public_id,
      cloudinaryResourceType: result.resource_type,
    };
    await req.portfolioUser.save();
    if (oldPublicId) await deleteFile(oldPublicId, oldResourceType);

    res.json({ portfolio: shapePortfolio(req.portfolioUser, { includePrivate: true }) });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteProfilePicture = async (req, res) => {
  try {
    const oldPublicId = req.portfolioUser.profilePicture?.cloudinaryPublicId;
    const oldResourceType = req.portfolioUser.profilePicture?.cloudinaryResourceType;
    if (oldPublicId) await deleteFile(oldPublicId, oldResourceType);

    req.portfolioUser.profilePicture = { cloudinaryPublicId: null, cloudinaryResourceType: null };
    await req.portfolioUser.save();
    res.json({ portfolio: shapePortfolio(req.portfolioUser, { includePrivate: true }) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteBackgroundImage = async (req, res) => {
  try {
    const oldPublicId = req.portfolioUser.backgroundImage?.cloudinaryPublicId;
    const oldResourceType = req.portfolioUser.backgroundImage?.cloudinaryResourceType;
    if (oldPublicId) await deleteFile(oldPublicId, oldResourceType);

    req.portfolioUser.backgroundImage = { cloudinaryPublicId: null, cloudinaryResourceType: null };
    await req.portfolioUser.save();
    res.json({ portfolio: shapePortfolio(req.portfolioUser, { includePrivate: true }) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getPublicPortfolio = async (req, res) => {
  try {
    const portfolioUser = await PortfolioUser.findOne({ slug: req.params.slug });
    if (!portfolioUser) {
      return res.status(404).json({ message: "Portfolio not found" });
    }
    res.json({ portfolio: shapePortfolio(portfolioUser) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
