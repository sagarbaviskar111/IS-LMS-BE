const jwt = require("jsonwebtoken");

// instituteSlug lets the frontend middleware route /<slug>/dashboard/...
// without a DB round trip on every request. Changing a slug only takes
// effect for a user on their next login — existing sessions keep the slug
// that was current when they signed in.
const generateToken = (user, instituteSlug) => {
  return jwt.sign(
    { id: user._id, role: user.role, instituteSlug: instituteSlug || null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || "7d" }
  );
};

module.exports = generateToken;
