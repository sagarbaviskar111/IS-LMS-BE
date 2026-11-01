const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "materials");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"]);
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

// Session recordings can be large — capped well above documents, which have
// no business being this big. Multer only supports one fileSize limit per
// instance, so this is the ceiling it enforces; materialController then
// applies the stricter DOCUMENT_MAX_SIZE itself once it knows the type.
const VIDEO_MAX_SIZE = 1024 * 1024 * 1024; // 1GB
const DOCUMENT_MAX_SIZE = 100 * 1024 * 1024; // 100MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (DOCUMENT_MIMES.has(file.mimetype) || VIDEO_MIMES.has(file.mimetype)) {
    return cb(null, true);
  }
  cb(new Error("Unsupported file type"));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: VIDEO_MAX_SIZE },
});

const resolveType = (mimeType) => (VIDEO_MIMES.has(mimeType) ? "video" : "document");

// Assignments (teacher attachments and student submissions) — documents plus
// photos, since handing in a photographed, handwritten answer is common.
const ASSIGNMENT_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "assignments");
fs.mkdirSync(ASSIGNMENT_UPLOAD_DIR, { recursive: true });

const assignmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ASSIGNMENT_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const assignmentFileFilter = (req, file, cb) => {
  if (DOCUMENT_MIMES.has(file.mimetype) || IMAGE_MIMES.has(file.mimetype)) {
    return cb(null, true);
  }
  cb(new Error("Unsupported file type"));
};

const assignmentUpload = multer({
  storage: assignmentStorage,
  fileFilter: assignmentFileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Institute logos (admin branding) — images only, small.
const LOGO_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "logos");
fs.mkdirSync(LOGO_UPLOAD_DIR, { recursive: true });

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGO_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const logoFileFilter = (req, file, cb) => {
  if (IMAGE_MIMES.has(file.mimetype)) return cb(null, true);
  cb(new Error("Unsupported file type"));
};

const logoUpload = multer({
  storage: logoStorage,
  fileFilter: logoFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Course registration — ID proofs (photo or PDF), selfie and signature images.
// Kept private: never served statically, only through an admin-only route.
const REGISTRATION_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "registrations");
fs.mkdirSync(REGISTRATION_UPLOAD_DIR, { recursive: true });

const registrationStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, REGISTRATION_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    cb(null, `${unique}${path.extname(file.originalname).toLowerCase().slice(0, 8)}`);
  },
});

const registrationFileFilter = (req, file, cb) => {
  const ok = IMAGE_MIMES.has(file.mimetype) || (file.fieldname.startsWith("idProof") && file.mimetype === "application/pdf");
  if (ok) return cb(null, true);
  cb(new Error("Unsupported file type — upload a photo (JPG/PNG) or PDF"));
};

const registrationUpload = multer({
  storage: registrationStorage,
  fileFilter: registrationFileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
});

// Certificate template backgrounds - PNG/JPG only (the PDF is drawn on top).
const CERT_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "certificates");
fs.mkdirSync(CERT_UPLOAD_DIR, { recursive: true });

const certificateStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CERT_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    cb(null, `${unique}${path.extname(file.originalname).toLowerCase().slice(0, 8)}`);
  },
});

const certificateUpload = multer({
  storage: certificateStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "image/png" || file.mimetype === "image/jpeg") return cb(null, true);
    cb(new Error("Upload the certificate as a PNG or JPG image"));
  },
  limits: { fileSize: 15 * 1024 * 1024 },
});

module.exports = {
  certificateUpload,
  upload,
  registrationUpload,
  REGISTRATION_UPLOAD_DIR,
  resolveType,
  UPLOAD_DIR,
  assignmentUpload,
  logoUpload,
  VIDEO_MAX_SIZE,
  DOCUMENT_MAX_SIZE,
};
