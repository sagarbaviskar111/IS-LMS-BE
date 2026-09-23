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

module.exports = { cloudinary, uploadFile, deleteFile, resolveResourceType, getFileUrl };
