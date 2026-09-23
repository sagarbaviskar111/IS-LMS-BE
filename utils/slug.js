const User = require("../models/User");

// "platform" is reserved for the superadmin console (/platform/dashboard/superadmin),
// which isn't tied to any one institute. The others are existing top-level routes.
const RESERVED_SLUGS = new Set(["platform", "login", "signup", "dashboard", "api", "register", "student-portfolio"]);

const slugify = (text) =>
  text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

// Appends -2, -3, ... until the slug is free. excludeId lets an admin keep
// their own slug when re-saving unchanged settings.
const generateUniqueSlug = async (base, excludeId) => {
  const root = slugify(base) || "institute";
  let candidate = root;
  let attempt = 1;

  while (true) {
    if (!RESERVED_SLUGS.has(candidate)) {
      const query = { instituteSlug: candidate };
      if (excludeId) query._id = { $ne: excludeId };
      const exists = await User.findOne(query).select("_id");
      if (!exists) return candidate;
    }
    attempt += 1;
    candidate = `${root}-${attempt}`;
  }
};

module.exports = { slugify, generateUniqueSlug, RESERVED_SLUGS };
