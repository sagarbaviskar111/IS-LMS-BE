const express = require("express");
const {
  getStudentPayment,
  updatePaymentDetails,
  recordPayment,
  extendDeadline,
  reactivateStudent,
} = require("../controllers/paymentController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.get("/students/:id", getStudentPayment);
router.patch("/students/:id", updatePaymentDetails);
router.post("/students/:id/record", recordPayment);
router.post("/students/:id/extend", extendDeadline);
router.post("/students/:id/reactivate", reactivateStudent);

module.exports = router;
