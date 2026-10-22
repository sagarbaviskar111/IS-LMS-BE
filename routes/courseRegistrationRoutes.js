const express = require("express");
const { getRegistrationInfo, submitRegistration } = require("../controllers/courseRegistrationController");
const { registrationUpload } = require("../utils/upload");

const router = express.Router();

// Public — a student opens this from the link the admin shares.
router.get("/:token", getRegistrationInfo);
router.post(
  "/:token",
  registrationUpload.fields([
    { name: "idProof1", maxCount: 1 },
    { name: "idProof2", maxCount: 1 },
    { name: "selfie", maxCount: 1 },
    { name: "signature", maxCount: 1 },
    { name: "profilePhoto", maxCount: 1 },
  ]),
  submitRegistration
);

module.exports = router;
