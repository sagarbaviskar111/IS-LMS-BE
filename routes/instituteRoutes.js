const express = require("express");
const {
  getPublicInstitute,
  getBranding,
  updateBranding,
  getRazorpaySettings,
  saveRazorpaySettings,
  removeRazorpaySettings,
} = require("../controllers/instituteController");
const { protect, authorize } = require("../middleware/auth");
const { logoUpload } = require("../utils/upload");

const router = express.Router();

// Registered before the public "/:slug" route so the literal path wins.
router.get("/branding", protect, authorize("admin"), getBranding);
router.patch("/branding", protect, authorize("admin"), logoUpload.single("logo"), updateBranding);

router.get("/razorpay", protect, authorize("admin"), getRazorpaySettings);
router.put("/razorpay", protect, authorize("admin"), saveRazorpaySettings);
router.delete("/razorpay", protect, authorize("admin"), removeRazorpaySettings);

router.get("/:slug", getPublicInstitute);

module.exports = router;
