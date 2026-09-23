const Message = require("../models/Message");
const User = require("../models/User");
const paginate = require("../utils/paginate");

const CHAT_ROLES = ["student", "teacher"];

const batchesOf = (u) => {
  if (u.role === "student") return u.batch ? [String(u.batch)] : [];
  if (u.role === "teacher") return (u.batches || []).map(String);
  return [];
};

// Two people may only message each other if they share at least one batch
// (and are in the same coaching class — implied by sharing a batch at all).
const shareBatch = (a, b) => {
  const batchesA = batchesOf(a);
  const batchesB = batchesOf(b);
  return batchesA.some((x) => batchesB.includes(x));
};

exports.sendMessage = async (req, res) => {
  try {
    if (!CHAT_ROLES.includes(req.user.role)) {
      return res.status(403).json({ message: "You are not authorized to use messaging" });
    }

    const { recipientId, text } = req.body;
    if (!recipientId || !text) {
      return res.status(400).json({ message: "recipientId and text are required" });
    }

    const recipient = await User.findOne({ _id: recipientId, role: { $in: CHAT_ROLES }, isActive: true });
    if (!recipient || !shareBatch(req.user, recipient)) {
      return res.status(403).json({ message: "You can only message people who share a batch with you" });
    }

    const message = await Message.create({
      sender: req.user._id,
      recipient: recipient._id,
      admin: req.user.admin,
      text,
    });

    res.status(201).json({ message: await message.populate("sender", "name role") });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getThread = async (req, res) => {
  try {
    if (!CHAT_ROLES.includes(req.user.role)) {
      return res.status(403).json({ message: "You are not authorized to use messaging" });
    }

    const otherId = req.params.userId;
    const other = await User.findOne({ _id: otherId, role: { $in: CHAT_ROLES } });
    if (!other || !shareBatch(req.user, other)) {
      return res.status(403).json({ message: "You can only message people who share a batch with you" });
    }

    const filter = {
      $or: [
        { sender: req.user._id, recipient: other._id },
        { sender: other._id, recipient: req.user._id },
      ],
    };
    const { page, limit, skip } = paginate(req, 30);

    const [messages, total] = await Promise.all([
      Message.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Message.countDocuments(filter),
    ]);

    res.json({
      messages: messages.reverse(),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.markThreadRead = async (req, res) => {
  try {
    if (!CHAT_ROLES.includes(req.user.role)) {
      return res.status(403).json({ message: "You are not authorized to use messaging" });
    }

    await Message.updateMany(
      { sender: req.params.userId, recipient: req.user._id, read: false },
      { $set: { read: true } }
    );
    res.json({ message: "Marked read" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.unreadSummary = async (req, res) => {
  try {
    if (!CHAT_ROLES.includes(req.user.role)) {
      return res.json({ bySender: {}, total: 0 });
    }

    const rows = await Message.aggregate([
      { $match: { recipient: req.user._id, read: false } },
      { $group: { _id: "$sender", count: { $sum: 1 } } },
    ]);

    const bySender = {};
    let total = 0;
    for (const r of rows) {
      bySender[String(r._id)] = r.count;
      total += r.count;
    }

    res.json({ bySender, total });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
