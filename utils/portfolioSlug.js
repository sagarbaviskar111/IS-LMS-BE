const PortfolioUser = require("../models/PortfolioUser");

// Slugs are always name + dob-digits + a random suffix, so a real collision
// with one of these words is not possible in practice — reserved purely as
// a safety net against the frontend's static /student-portfolio/<word> routes.
const RESERVED_PORTFOLIO_SLUGS = new Set(["create", "login", "dashboard", "edit", "logout"]);

const slugifyName = (text) =>
  text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const generatePortfolioSlug = async (name, dob) => {
  const namePart = slugifyName(name) || "student";
  const dobDate = new Date(dob);
  const yy = String(dobDate.getFullYear()).slice(-2);
  const mm = String(dobDate.getMonth() + 1).padStart(2, "0");
  const dd = String(dobDate.getDate()).padStart(2, "0");
  const dobPart = `${yy}${mm}${dd}`;

  for (let attempt = 0; attempt < 20; attempt++) {
    const randomPart = Math.floor(100 + Math.random() * 900);
    const candidate = `${namePart}-${dobPart}${randomPart}`;
    if (RESERVED_PORTFOLIO_SLUGS.has(candidate)) continue;
    const exists = await PortfolioUser.findOne({ slug: candidate }).select("_id");
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique portfolio slug");
};

module.exports = { generatePortfolioSlug, slugifyName, RESERVED_PORTFOLIO_SLUGS };
