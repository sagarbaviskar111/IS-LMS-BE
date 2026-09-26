const crypto = require("crypto");
const Notification = require("../models/Notification");
const User = require("../models/User");
const paginate = require("../utils/paginate");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Who each role is allowed to notify, and how the recipient set is resolved.
const resolveRecipients = async (req) => {
  const { recipientId, recipientRole, batchId, broadcast } = req.body;

  if (req.user.role === "superadmin") {
    if (broadcast) {
      return User.find({ role: "admin" });
    }
    if (!recipientId) throw new HttpError(400, "recipientId is required");
    const admin = await User.findOne({ _id: recipientId, role: "admin" });
    if (!admin) throw new HttpError(400, "Invalid recipient");
    return [admin];
  }

  if (req.user.role === "admin") {
    if (!["teacher", "telecaller", "student"].includes(recipientRole)) {
      throw new HttpError(400, "recipientRole must be teacher, telecaller, or student");
    }
    if (broadcast) {
      return User.find({ admin: req.user._id, role: recipientRole, isActive: true });
    }
    if (!recipientId) throw new HttpError(400, "recipientId is required");
    const u = await User.findOne({ _id: recipientId, admin: req.user._id, role: recipientRole });
    if (!u) throw new HttpError(400, "Invalid recipient");
    return [u];
  }

  if (req.user.role === "teacher") {
    const assigned = (req.user.batches || []).some((b) => String(b) === String(batchId));
    if (!batchId || !assigned) {
      throw new HttpError(403, "You are not assigned to this batch");
    }
    if (broadcast) {
      return User.find({ admin: req.user.admin, role: "student", batch: batchId, isActive: true });
    }
    if (!recipientId) throw new HttpError(400, "recipientId is required");
    const u = await User.findOne({ _id: recipientId, role: "student", batch: batchId });
    if (!u) throw new HttpError(400, "Invalid recipient");
    return [u];
  }

  throw new HttpError(403, "You are not authorized to send notifications");
};

exports.sendNotification = async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) {
      return res.status(400).json({ message: "title and message are required" });
    }

    const recipients = await resolveRecipients(req);
    if (!recipients || recipients.length === 0) {
      return res.status(400).json({ message: "No recipients found" });
    }

    const sendBatchId = crypto.randomUUID();
    const docs = recipients.map((r) => ({
      recipient: r._id,
      sender: req.user._id,
      senderRole: req.user.role,
      title,
      message,
      sendBatchId,
    }));

    const created = await Notification.insertMany(docs);
    res.status(201).json({ count: created.length, sendBatchId });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.listMyNotifications = async (req, res) => {
  try {
    const filter = { recipient: req.user._id };
    const { page, limit, skip } = paginate(req);

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .populate("sender", "name role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Notification.countDocuments(filter),
      Notification.countDocuments({ ...filter, read: false }),
    ]);

    res.json({
      notifications,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      unreadCount,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.unreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({ recipient: req.user._id, read: false });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.markRead = async (req, res) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, recipient: req.user._id });
    if (!notification) return res.status(404).json({ message: "Notification not found" });

    notification.read = true;
    notification.readAt = new Date();
    await notification.save();

    res.json({ notification });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listSentNotifications = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);

    const grouped = await Notification.aggregate([
      { $match: { sender: req.user._id } },
      {
        $group: {
          _id: "$sendBatchId",
          title: { $first: "$title" },
          message: { $first: "$message" },
          createdAt: { $first: "$createdAt" },
          totalRecipients: { $sum: 1 },
          readCount: { $sum: { $cond: ["$read", 1, 0] } },
        },
      },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]);

    const totalGroups = await Notification.aggregate([
      { $match: { sender: req.user._id } },
      { $group: { _id: "$sendBatchId" } },
      { $count: "count" },
    ]);
    const total = totalGroups[0]?.count || 0;

    res.json({
      sent: grouped.map((g) => ({
        sendBatchId: g._id,
        title: g.title,
        message: g.message,
        createdAt: g.createdAt,
        totalRecipients: g.totalRecipients,
        readCount: g.readCount,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getSentNotificationDetail = async (req, res) => {
  try {
    const notifications = await Notification.find({
      sender: req.user._id,
      sendBatchId: req.params.sendBatchId,
    }).populate("recipient", "name email role");

    if (notifications.length === 0) {
      return res.status(404).json({ message: "Not found" });
    }

    const recipients = notifications
      .map((n) => ({ recipient: n.recipient, read: n.read, readAt: n.readAt }))
      .sort((a, b) => (a.recipient?.name || "").localeCompare(b.recipient?.name || ""));

    res.json({
      title: notifications[0].title,
      message: notifications[0].message,
      createdAt: notifications[0].createdAt,
      recipients,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient: req.user._id, read: false },
      { $set: { read: true, readAt: new Date() } }
    );
    res.json({ message: "All marked read" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
