const express = require("express");
const { getStatus, saveStorage, removeStorage } = require("../controllers/storageController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));
router.get("/status", getStatus);
router.put("/config", saveStorage);
router.delete("/config", removeStorage);

module.exports = router;
