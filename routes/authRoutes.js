const express = require("express");
const {
  login,
  register,
  inviteInfo,
  leadInfo,
  registerViaLead,
  createLeadPaymentOrder,
  verifyLeadPayment,
  logout,
  me,
  forgotPassword,
  resetPassword,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.post("/login", login);
router.get("/invite-info", inviteInfo);
router.post("/register", register);
router.get("/lead-info", leadInfo);
router.post("/register-lead", registerViaLead);
router.post("/lead-payment/order", createLeadPaymentOrder);
router.post("/lead-payment/verify", verifyLeadPayment);
router.post("/logout", logout);
router.get("/me", protect, me);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

module.exports = router;
