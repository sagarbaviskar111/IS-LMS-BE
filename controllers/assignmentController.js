const fs = require("fs");
const Assignment = require("../models/Assignment");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const User = require("../models/User");
const { uploadFile, deleteFile, resolveResourceType } = require("../utils/cloudinary");
const { withFileUrl, withAttachmentUrl } = require("../utils/fileUrlView");

const isAssigned = (req, batchId) =>
  (req.user.batches || []).some((b) => String(b) === String(batchId));

const loadOwnedAssignment = async (req) => {
  const assignment = await Assignment.findById(req.params.id);
  if (!assignment) return { error: [404, "Assignment not found"] };
  if (!isAssigned(req, assignment.batch)) return { error: [403, "Not authorized"] };
  return { assignment };
};

const serializeAssignment = (a) => {
  const obj = a.toObject ? a.toObject() : { ...a };
  return { ...obj, attachment: withAttachmentUrl(obj.attachment) };
};

exports.createAssignment = async (req, res) => {
  try {
    const { batch, title, description, dueDate } = req.body;
    if (!batch || !title || !dueDate) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: "batch, title and dueDate are required" });
    }
    if (!isAssigned(req, batch)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ message: "You are not assigned to this batch" });
    }
    if (Number.isNaN(new Date(dueDate).getTime())) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: "dueDate is invalid" });
    }

    let attachment = {};
    if (req.file) {
      try {
        const resourceType = resolveResourceType(req.file.mimetype);
        const result = await uploadFile(req.file.path, { folder: `assignments/${batch}`, resourceType });
        attachment = {
          fileName: req.file.originalname,
          cloudinaryPublicId: result.public_id,
          cloudinaryResourceType: result.resource_type,
          fileSize: req.file.size,
          mimeType: req.file.mimetype,
        };
      } catch (err) {
        fs.unlink(req.file.path, () => {});
        return res.status(502).json({ message: "Attachment upload failed — please try again" });
      }
      fs.unlink(req.file.path, () => {});
    }

    const assignment = await Assignment.create({
      batch,
      admin: req.user.admin,
      createdBy: req.user._id,
      title,
      description,
      dueDate,
      attachment,
    });

    res.status(201).json({ assignment: serializeAssignment(assignment) });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ message: "Server error" });
  }
};

exports.listAssignments = async (req, res) => {
  try {
    const { batch } = req.query;
    if (!batch) return res.status(400).json({ message: "batch is required" });
    if (!isAssigned(req, batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const [assignments, studentCount] = await Promise.all([
      Assignment.find({ batch }).sort({ dueDate: 1 }),
      User.countDocuments({ role: "student", admin: req.user.admin, batch, isActive: true }),
    ]);

    const counts = await AssignmentSubmission.aggregate([
      { $match: { assignment: { $in: assignments.map((a) => a._id) } } },
      { $group: { _id: "$assignment", count: { $sum: 1 } } },
    ]);
    const countByAssignment = new Map(counts.map((c) => [String(c._id), c.count]));

    res.json({
      assignments: assignments.map((a) => ({
        _id: a._id,
        batch: a.batch,
        title: a.title,
        description: a.description,
        dueDate: a.dueDate,
        attachment: withAttachmentUrl(a.attachment),
        submittedCount: countByAssignment.get(String(a._id)) || 0,
        studentCount,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getAssignment = async (req, res) => {
  try {
    const { assignment, error } = await loadOwnedAssignment(req);
    if (error) return res.status(error[0]).json({ message: error[1] });
    res.json({ assignment: serializeAssignment(assignment) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateAssignment = async (req, res) => {
  try {
    const { assignment, error } = await loadOwnedAssignment(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { title, description, dueDate } = req.body;
    if (title !== undefined) assignment.title = title;
    if (description !== undefined) assignment.description = description;
    if (dueDate !== undefined) {
      if (Number.isNaN(new Date(dueDate).getTime())) {
        return res.status(400).json({ message: "dueDate is invalid" });
      }
      assignment.dueDate = dueDate;
    }

    await assignment.save();
    res.json({ assignment: serializeAssignment(assignment) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteAssignment = async (req, res) => {
  try {
    const { assignment, error } = await loadOwnedAssignment(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const submissions = await AssignmentSubmission.find({ assignment: assignment._id });

    await Promise.all([
      assignment.deleteOne(),
      AssignmentSubmission.deleteMany({ assignment: assignment._id }),
    ]);

    if (assignment.attachment?.cloudinaryPublicId) {
      await deleteFile(assignment.attachment.cloudinaryPublicId, assignment.attachment.cloudinaryResourceType);
    }
    await Promise.all(
      submissions.map((s) => deleteFile(s.cloudinaryPublicId, s.cloudinaryResourceType))
    );

    res.json({ message: "Assignment deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listSubmissions = async (req, res) => {
  try {
    const { assignment, error } = await loadOwnedAssignment(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const [submissions, students] = await Promise.all([
      AssignmentSubmission.find({ assignment: assignment._id })
        .populate("student", "name email")
        .sort({ submittedAt: -1 }),
      User.find({ role: "student", admin: req.user.admin, batch: assignment.batch, isActive: true })
        .select("name email")
        .sort({ name: 1 }),
    ]);

    const submittedIds = new Set(submissions.map((s) => String(s.student._id)));
    const notSubmitted = students.filter((s) => !submittedIds.has(String(s._id)));

    res.json({ submissions: submissions.map(withFileUrl), notSubmitted });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
