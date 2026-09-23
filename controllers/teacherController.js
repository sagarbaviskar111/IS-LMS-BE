const Batch = require("../models/Batch");
const User = require("../models/User");

exports.youtubeStatus = async (req, res) => {
  try {
    const admin = await User.findById(req.user.admin).select("youtube.connected youtube.channelTitle");
    res.json({
      connected: !!(admin && admin.youtube && admin.youtube.connected),
      channelTitle: admin && admin.youtube ? admin.youtube.channelTitle : null,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listMyBatches = async (req, res) => {
  try {
    const batches = await Batch.find({ _id: { $in: req.user.batches || [] } }).sort({ name: 1 });
    res.json({ batches });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listBatchStudents = async (req, res) => {
  try {
    const batchId = req.params.id;
    const isAssigned = (req.user.batches || []).some((b) => String(b) === batchId);
    if (!isAssigned) {
      return res.status(403).json({ message: "You are not assigned to this batch" });
    }

    const students = await User.find({
      role: "student",
      admin: req.user.admin,
      batch: batchId,
    }).sort({ name: 1 });

    res.json({ students });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.batchNetwork = async (req, res) => {
  try {
    const batchId = req.params.id;
    const isAssigned = (req.user.batches || []).some((b) => String(b) === batchId);
    if (!isAssigned) {
      return res.status(403).json({ message: "You are not assigned to this batch" });
    }

    const [students, teachers] = await Promise.all([
      User.find({ role: "student", admin: req.user.admin, batch: batchId, isActive: true }).select(
        "name email"
      ),
      User.find({
        role: "teacher",
        admin: req.user.admin,
        batches: batchId,
        isActive: true,
        _id: { $ne: req.user._id },
      }).select("name email"),
    ]);

    res.json({ students, teachers });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
