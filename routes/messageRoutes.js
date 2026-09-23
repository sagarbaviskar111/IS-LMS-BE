const express = require("express");
const {
  sendMessage,
  getThread,
  markThreadRead,
  unreadSummary,
} = require("../controllers/messageController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.use(protect);

router.post("/", sendMessage);
router.get("/unread-summary", unreadSummary);
router.get("/with/:userId", getThread);
router.patch("/read/:userId", markThreadRead);

module.exports = router;
