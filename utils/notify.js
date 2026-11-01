const crypto = require("crypto");
const Notification = require("../models/Notification");

// Sends one in-app notification from `sender` to each recipient id. Failures
// are swallowed: a missed notification must never fail the action behind it.
const notifyUsers = async (sender, recipientIds, title, message) => {
  if (!recipientIds.length) return;
  const sendBatchId = crypto.randomUUID();
  try {
    await Notification.insertMany(
      recipientIds.map((recipient) => ({
        recipient,
        sender: sender._id,
        senderRole: sender.role,
        sendBatchId,
        title,
        message,
      }))
    );
  } catch (err) {
    console.error("[notify] failed:", err.message);
  }
};

module.exports = { notifyUsers };
