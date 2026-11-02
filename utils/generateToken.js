const jwt = require("jsonwebtoken");

// instituteSlug lets the frontend middleware route /<slug>/dashboard/...
// without a DB round trip on every request. Changing a slug only takes
// effect for a user on their next login — existing sessions keep the slug
// that was current when they signed in.
const generateToken = (user, instituteSlug) => {
  return jwt.sign(
    // A sub-admin uses the admin's dashboard URLs, so its token carries the admin role for routing;
    // the server still loads the real account (and its limits) from `id`.
    { id: user._id, role: user.role === "subadmin" ? "admin" : user.role, instituteSlug: instituteSlug || null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || "7d" }
  );
};

module.exports = generateToken;
