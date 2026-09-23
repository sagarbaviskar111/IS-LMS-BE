const express = require("express");
const { getStatus, connect, callback, disconnectAccount } = require("../controllers/youtubeController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Google redirects the admin's browser here directly — no session cookie
// round-trip is guaranteed, so this one relies on the signed `state` instead
// of the protect middleware.
router.get("/callback", callback);

router.use(protect, authorize("admin"));
router.get("/status", getStatus);
router.get("/connect", connect);
router.delete("/disconnect", disconnectAccount);

module.exports = router;
