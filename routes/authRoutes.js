const express = require("express");
const {
  login,
  devLogin,
  register,
  inviteInfo,
  leadInfo,
  registerViaLead,
  createLeadPaymentOrder,
  verifyLeadPayment,
  payDues,
  logout,
  me,
  updateMe,
  forgotPassword,
  resetPassword,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const { logoUpload } = require("../utils/upload");

const router = express.Router();

router.post("/login", login);
router.post("/dev-login", devLogin);
router.get("/invite-info", inviteInfo);
router.post("/register", register);
router.get("/lead-info", leadInfo);
router.post("/register-lead", registerViaLead);
router.post("/lead-payment/order", createLeadPaymentOrder);
router.post("/lead-payment/verify", verifyLeadPayment);
router.post("/dues-payment", payDues);
router.post("/me/dues-payment", protect, payDues);
router.post("/logout", logout);
router.get("/me", protect, me);
router.patch("/me", protect, logoUpload.single("avatar"), updateMe);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

module.exports = router;
