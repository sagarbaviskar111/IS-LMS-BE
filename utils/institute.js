const User = require("./../models/User");
const { getFileUrl } = require("./cloudinary");

const shapeInstitute = (admin) => {
  if (!admin || !admin.instituteSlug) return null;
  return {
    name: admin.name,
    slug: admin.instituteSlug,
    brandColor: admin.brandColor || null,
    logoUrl: admin.logo?.cloudinaryPublicId
      ? getFileUrl(admin.logo.cloudinaryPublicId, admin.logo.cloudinaryResourceType)
      : null,
  };
};

// Resolves the institute (coaching class) a user belongs to — themselves if
// they're the admin, otherwise a lookup on their `admin` reference. Returns
// null for superadmin or an admin who hasn't set up branding yet (no slug).
const resolveInstitute = async (user) => {
  if (user.role === "admin") return shapeInstitute(user);
  if (!user.admin) return null;

  const admin = await User.findById(user.admin).select("name instituteSlug brandColor logo");
  return shapeInstitute(admin);
};

module.exports = { resolveInstitute, shapeInstitute };
