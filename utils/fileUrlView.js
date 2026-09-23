const { getFileUrl } = require("./cloudinary");

// Attaches a freshly-signed fileUrl to a document (Material, AssignmentSubmission)
// that stores cloudinaryPublicId/cloudinaryResourceType at its top level.
// Also strips the ready-made youtubeUrl (Material only) — the client only
// gets the bare videoId it needs to mount our own player, never a
// copy-pasteable youtube.com link.
const withFileUrl = (doc) => {
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  obj.fileUrl = getFileUrl(obj.cloudinaryPublicId, obj.cloudinaryResourceType);
  delete obj.youtubeUrl;
  return obj;
};

// Same, but for an embedded `attachment` sub-object (Assignment.attachment).
const withAttachmentUrl = (attachment) => {
  if (!attachment) return attachment;
  const obj = attachment.toObject ? attachment.toObject() : { ...attachment };
  obj.fileUrl = getFileUrl(obj.cloudinaryPublicId, obj.cloudinaryResourceType);
  return obj;
};

module.exports = { withFileUrl, withAttachmentUrl };
