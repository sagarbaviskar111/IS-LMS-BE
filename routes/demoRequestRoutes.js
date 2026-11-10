const express = require("express");
const c = require("../controllers/demoRequestController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Per-IP limiter for the public form.
const hits = new Map();
const limit = (req, res, next) => {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 8) return res.status(429).json({ message: "Too many requests. Please try again later." });
  recent.push(now);
  hits.set(req.ip, recent);
  next();
};

router.post("/", limit, c.create);

router.use(protect, authorize("superadmin"));
router.get("/", c.list);
router.patch("/:id", c.update);
router.delete("/:id", c.remove);

module.exports = router;
