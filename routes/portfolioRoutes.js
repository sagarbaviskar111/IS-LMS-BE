const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/portfolioController");
const { protectPortfolio } = require("../middleware/portfolioAuth");
const { logoUpload } = require("../utils/upload");

router.post("/register", ctrl.register);
router.post("/login", ctrl.login);
router.post("/logout", ctrl.logout);
router.get("/public/:slug", ctrl.getPublicPortfolio);

router.get("/me", protectPortfolio, ctrl.me);
router.patch("/me", protectPortfolio, ctrl.updateMe);
router.post("/me/profile-picture", protectPortfolio, logoUpload.single("image"), ctrl.uploadProfilePicture);
router.post("/me/background-image", protectPortfolio, logoUpload.single("image"), ctrl.uploadBackgroundImage);
router.delete("/me/profile-picture", protectPortfolio, ctrl.deleteProfilePicture);
router.delete("/me/background-image", protectPortfolio, ctrl.deleteBackgroundImage);

module.exports = router;
