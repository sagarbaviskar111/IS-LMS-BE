const jwt = require("jsonwebtoken");
const User = require("../models/User");
const SubadminActivity = require("../models/SubadminActivity");
const { enforceFeeDeadline } = require("../utils/paymentCycle");
const { checkAccess } = require("../utils/permissions");

// Replaces ids in a path so the activity list reads "/api/payments/students/:id/record".
const cleanPath = (url) => url.split("?")[0].replace(/\/[0-9a-f]{24}(?=\/|$)/gi, "/:id");

const protect = async (req, res, next) => {
  try {
    const token = req.cookies?.token;
    if (!token) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (user) await enforceFeeDeadline(user);

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (user.role === "subadmin") {
      // A sub-admin works inside its admin's institute. Every admin screen already
      // scopes its data by req.user, so the request runs as that admin, but only
      // for the modules this sub-admin was given. req.actor stays the real person.
      const admin = user.admin ? await User.findById(user.admin) : null;
      if (!admin || !admin.isActive) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      const url = req.originalUrl.split("?")[0];
      // Own profile (name, photo) stays on the sub-admin's own account.
      if (url.startsWith("/api/auth")) {
        req.user = user;
        return next();
      }
      const access = checkAccess(user.permissions, req.method, url);
      if (!access.ok) {
        return res.status(403).json({ message: access.message });
      }
      req.actor = user;
      req.user = admin;
      // Keep a record of what a sub-admin changed.
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const entry = { admin: admin._id, subadmin: user._id, module: access.module, method: req.method, path: cleanPath(req.originalUrl) };
        res.on("finish", () => {
          if (res.statusCode < 400) SubadminActivity.create(entry).catch(() => {});
        });
      }
      return next();
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Not authenticated" });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    next();
  };
};

module.exports = { protect, authorize };
