const Batch = require("../models/Batch");
const User = require("../models/User");
const paginate = require("../utils/paginate");

exports.youtubeStatus = async (req, res) => {
  try {
    const admin = await User.findById(req.user.admin).select(
      "youtube.connected youtube.channelTitle videoFlow videoStorage.verified"
    );
    const flow = (admin && admin.videoFlow) || "youtube";
    // `connected` means "this institute is ready to accept a recording" for
    // whichever flow it's on, so the upload UI doesn't need to know which.
    const connected =
      flow === "storage"
        ? !!(admin && admin.videoStorage && admin.videoStorage.verified)
        : !!(admin && admin.youtube && admin.youtube.connected);
    res.json({
      connected,
      flow,
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

    const { page, limit, skip } = paginate(req);
    const filter = { role: "student", admin: req.user.admin, batch: batchId };

    const [students, total] = await Promise.all([
      User.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);

    res.json({ students, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
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
