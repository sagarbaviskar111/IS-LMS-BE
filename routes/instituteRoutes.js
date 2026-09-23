const express = require("express");
const { getPublicInstitute, getBranding, updateBranding } = require("../controllers/instituteController");
const { protect, authorize } = require("../middleware/auth");
const { logoUpload } = require("../utils/upload");

const router = express.Router();

// Registered before the public "/:slug" route so the literal path wins.
router.get("/branding", protect, authorize("admin"), getBranding);
router.patch("/branding", protect, authorize("admin"), logoUpload.single("logo"), updateBranding);

router.get("/:slug", getPublicInstitute);

module.exports = router;
