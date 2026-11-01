const express = require("express");
const {
  listEntries,
  summary,
  categories,
  createEntry,
  updateEntry,
  deleteEntry,
  exportCsv,
} = require("../controllers/financeController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.get("/entries", listEntries);
router.get("/summary", summary);
router.get("/categories", categories);
router.get("/export", exportCsv);
router.post("/entries", createEntry);
router.patch("/entries/:id", updateEntry);
router.delete("/entries/:id", deleteEntry);

module.exports = router;
