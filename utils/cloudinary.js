const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Cloudinary buckets non-image files as "raw" — images get its transformation
// pipeline, everything else (pdf/doc/ppt/xlsx...) is stored as-is.
const resolveResourceType = (mimeType) => (mimeType.startsWith("image/") ? "image" : "raw");

const uploadFile = (filePath, { folder, resourceType }) =>
  cloudinary.uploader.upload(filePath, { folder, resource_type: resourceType });

const deleteFile = (publicId, resourceType) => {
  if (!publicId) return Promise.resolve();
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType || "raw" }).catch(() => {});
};

// Cloudinary's account-wide security setting blocks public CDN delivery of
// PDF/ZIP files (res.cloudinary.com returns 401 "deny or ACL failure"),
// regardless of resource_type or signed/authenticated delivery type — the
// restriction applies at the edge before any signature check. The Admin API's
// signed "download" endpoint (api.cloudinary.com, not the CDN domain) is a
// separate access path that isn't subject to that restriction, so we use it
// for every document link instead of the plain secure_url.
// Generated fresh per request rather than stored — cheap (pure HMAC signing,
// no network call) and avoids ever persisting a URL that could go stale.
const getFileUrl = (publicId, resourceType) => {
  if (!publicId) return null;
  return cloudinary.utils.private_download_url(publicId, null, {
    resource_type: resourceType || "raw",
    type: "upload",
  });
};

// ---- private verification documents (ID proofs, selfie, signature) ---------
// Stored as "authenticated" assets: no public URL exists, so they can only be
// read through a short-lived signed link that the server creates for the owning
// admin. Photos are shrunk (max 1600px, auto quality) as part of the upload;
// PDFs are stored as they are.
const uploadPrivate = async (filePath, { folder, mimetype, imageFormat = "jpg" }) => {
  const isImage = String(mimetype || "").startsWith("image/");
  const result = await cloudinary.uploader.upload(filePath, {
    folder,
    type: "authenticated",
    resource_type: isImage ? "image" : "raw",
    ...(isImage
      ? {
          format: imageFormat,
          transformation: [{ width: 1600, height: 1600, crop: "limit", quality: "auto:good" }],
        }
      : {}),
  });
  return {
    cloudinaryPublicId: result.public_id,
    cloudinaryResourceType: result.resource_type,
    format: isImage ? imageFormat : null,
    bytes: result.bytes,
    mimetype: isImage ? `image/${imageFormat === "jpg" ? "jpeg" : imageFormat}` : mimetype,
  };
};

const deletePrivate = (publicId, resourceType) => {
  if (!publicId) return Promise.resolve();
  return cloudinary.uploader
    .destroy(publicId, { resource_type: resourceType || "raw", type: "authenticated" })
    .catch(() => {});
};

// A signed link that works for a few minutes, never stored.
const getPrivateFileUrl = (publicId, resourceType, format) =>
  cloudinary.utils.private_download_url(publicId, format || null, {
    resource_type: resourceType || "raw",
    type: "authenticated",
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });

module.exports = {
  cloudinary,
  uploadFile,
  deleteFile,
  resolveResourceType,
  getFileUrl,
  uploadPrivate,
  deletePrivate,
  getPrivateFileUrl,
};
