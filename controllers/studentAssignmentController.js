const fs = require("fs");
const Assignment = require("../models/Assignment");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const { uploadFile, deleteFile, resolveResourceType } = require("../utils/cloudinary");
const { withFileUrl, withAttachmentUrl } = require("../utils/fileUrlView");

exports.listAssignments = async (req, res) => {
  try {
    if (!req.user.batch) return res.json({ assignments: [] });

    const assignments = await Assignment.find({ batch: req.user.batch }).sort({ dueDate: 1 });
    const submissions = await AssignmentSubmission.find({
      assignment: { $in: assignments.map((a) => a._id) },
      student: req.user._id,
    });
    const submissionByAssignment = new Map(submissions.map((s) => [String(s.assignment), s]));

    const now = Date.now();

    res.json({
      assignments: assignments.map((a) => {
        const submission = submissionByAssignment.get(String(a._id));
        const overdue = new Date(a.dueDate).getTime() < now;
        return {
          _id: a._id,
          title: a.title,
          description: a.description,
          dueDate: a.dueDate,
          attachment: withAttachmentUrl(a.attachment),
          submitted: !!submission,
          submission: submission
            ? {
                fileName: submission.fileName,
                fileUrl: withFileUrl(submission).fileUrl,
                fileSize: submission.fileSize,
                mimeType: submission.mimeType,
                submittedAt: submission.submittedAt,
              }
            : null,
          // Locked once the due date has passed and nothing was ever turned in.
          locked: overdue && !submission,
          overdue,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.submitAssignment = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "file is required" });
    }

    const assignment = await Assignment.findById(req.params.id);
    if (!assignment) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ message: "Assignment not found" });
    }
    if (!req.user.batch || String(assignment.batch) !== String(req.user.batch)) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ message: "Not authorized" });
    }
    if (new Date(assignment.dueDate).getTime() < Date.now()) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: "The due date for this assignment has passed" });
    }

    const existing = await AssignmentSubmission.findOne({ assignment: assignment._id, student: req.user._id });

    let result;
    try {
      const resourceType = resolveResourceType(req.file.mimetype);
      result = await uploadFile(req.file.path, {
        folder: `assignments/${assignment.batch}/submissions`,
        resourceType,
      });
    } catch (err) {
      fs.unlink(req.file.path, () => {});
      return res.status(502).json({ message: "Upload failed — please try again" });
    }
    fs.unlink(req.file.path, () => {});

    const payload = {
      assignment: assignment._id,
      student: req.user._id,
      batch: assignment.batch,
      fileName: req.file.originalname,
      cloudinaryPublicId: result.public_id,
      cloudinaryResourceType: result.resource_type,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      submittedAt: new Date(),
    };

    let submission;
    if (existing) {
      // Resubmission before the due date replaces the previous file.
      const oldPublicId = existing.cloudinaryPublicId;
      const oldResourceType = existing.cloudinaryResourceType;
      Object.assign(existing, payload);
      submission = await existing.save();
      await deleteFile(oldPublicId, oldResourceType);
    } else {
      submission = await AssignmentSubmission.create(payload);
    }

    res.status(existing ? 200 : 201).json({ message: "Submitted", submission: withFileUrl(submission) });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (err.code === 11000) {
      return res.status(409).json({ message: "You've already submitted this assignment" });
    }
    res.status(500).json({ message: "Server error" });
  }
};
