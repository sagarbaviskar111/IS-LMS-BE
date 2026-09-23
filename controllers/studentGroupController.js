const StudentGroup = require("../models/StudentGroup");
const User = require("../models/User");

// Validates that every id belongs to a student in this admin's tenant.
const resolveGroupStudents = async (adminId, studentIds) => {
  const unique = [...new Set(studentIds)];
  if (unique.length === 0) return [];
  const found = await User.find({ _id: { $in: unique }, role: "student", admin: adminId });
  if (found.length !== unique.length) throw new Error("One or more students are invalid");
  return found.map((s) => s._id);
};

exports.createGroup = async (req, res) => {
  try {
    const { name, studentIds } = req.body;
    if (!name) {
      return res.status(400).json({ message: "name is required" });
    }

    let students = [];
    try {
      students = await resolveGroupStudents(req.user._id, studentIds || []);
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const group = await StudentGroup.create({
      name,
      admin: req.user._id,
      students,
    });

    res.status(201).json({ group });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "You already have a group with this name" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.listGroups = async (req, res) => {
  try {
    const groups = await StudentGroup.find({ admin: req.user._id })
      .populate("students", "name email")
      .sort({ name: 1 });

    res.json({ groups });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateGroup = async (req, res) => {
  try {
    const group = await StudentGroup.findOne({ _id: req.params.id, admin: req.user._id });
    if (!group) return res.status(404).json({ message: "Group not found" });

    const { name, studentIds } = req.body;

    if (name !== undefined) group.name = name;

    if (studentIds !== undefined) {
      try {
        group.students = await resolveGroupStudents(req.user._id, studentIds);
      } catch (err) {
        return res.status(400).json({ message: err.message });
      }
    }

    await group.save();
    await group.populate("students", "name email");

    res.json({ group });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "You already have a group with this name" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteGroup = async (req, res) => {
  try {
    const group = await StudentGroup.findOne({ _id: req.params.id, admin: req.user._id });
    if (!group) return res.status(404).json({ message: "Group not found" });

    await group.deleteOne();

    res.json({ message: "Group deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
