const express = require("express");
const {
  getStudentPayment,
  updatePaymentDetails,
  recordPayment,
  extendDeadline,
  reactivateStudent,
  editInstallment,
  attentionOrders,
  addConcession,
} = require("../controllers/paymentController");
const { adminReceipt } = require("../controllers/receiptController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.get("/receipts/:id", adminReceipt);
router.get("/orders/attention", attentionOrders);
router.get("/students/:id", getStudentPayment);
router.patch("/students/:id", updatePaymentDetails);
router.post("/students/:id/record", recordPayment);
router.post("/students/:id/extend", extendDeadline);
router.post("/students/:id/reactivate", reactivateStudent);
router.post("/students/:id/concession", addConcession);
router.patch("/students/:id/installments/:itemId", editInstallment);

module.exports = router;
