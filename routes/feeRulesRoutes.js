const express = require("express");
const { getFeeRules, previewFeeRules, saveFeeRules } = require("../controllers/feeRulesController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.get("/", getFeeRules);
router.post("/preview", previewFeeRules);
router.put("/", saveFeeRules);

module.exports = router;
