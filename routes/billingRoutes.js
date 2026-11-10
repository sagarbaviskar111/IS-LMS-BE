const express = require("express");
const c = require("../controllers/billingController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Tiny per-IP limiter so the public signup can't be spammed.
const hits = new Map();
const signupLimit = (req, res, next) => {
  const now = Date.now();
  const key = req.ip;
  const recent = (hits.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ message: "Too many signups from this network. Try again later." });
  recent.push(now);
  hits.set(key, recent);
  next();
};

router.get("/plans", c.publicPlans);
router.post("/signup", signupLimit, c.signup);

router.get("/me", protect, authorize("admin"), c.myBilling);
router.post("/quote", protect, authorize("admin"), c.previewQuote);
router.post("/order", protect, authorize("admin"), c.createOrder);
router.post("/verify", protect, authorize("admin"), c.verifyOrder);

const sa = express.Router();
sa.use(protect, authorize("superadmin"));
sa.get("/settings", c.getSettings);
sa.put("/settings", c.updateSettings);
sa.get("/plans", c.listPlans);
sa.post("/plans", c.createPlan);
sa.patch("/plans/:id", c.updatePlan);
sa.delete("/plans/:id", c.deletePlan);
sa.get("/subscriptions", c.listSubscriptions);
sa.patch("/subscriptions/:adminId", c.updateSubscription);
router.use("/superadmin", sa);

module.exports = router;
