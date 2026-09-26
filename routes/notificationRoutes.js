const express = require("express");
const {
  sendNotification,
  listMyNotifications,
  unreadCount,
  markRead,
  markAllRead,
  listSentNotifications,
  getSentNotificationDetail,
} = require("../controllers/notificationController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.use(protect);

router.get("/", listMyNotifications);
router.get("/unread-count", unreadCount);
router.post("/", sendNotification);
router.patch("/read-all", markAllRead);
router.patch("/:id/read", markRead);
router.get("/sent", listSentNotifications);
router.get("/sent/:sendBatchId", getSentNotificationDetail);

module.exports = router;
