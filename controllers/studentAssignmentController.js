const fs = require("fs");
const Assignment = require("../models/Assignment");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const { uploadFile, deleteFile, resolveResourceType } = require("../utils/cloudinary");
const { withFileUrl, withAttachmentUrl } = require("../utils/fileUrlView");
const paginate = require("../utils/paginate");

// Whether the student may upload (or re-upload) right now, and why not.
//  - cancelled assignments are closed
//  - an approved or rejected submission is final
//  - after the due date only a teacher's "resubmit" request (until its deadline) reopens it
const submitGate = (assignment, submission, now = Date.now()) => {
  if (assignment.status === "cancelled") return { canSubmit: false, reason: "This assignment was cancelled by your teacher" };
  if (submission && submission.decision === "approved") return { canSubmit: false, reason: "Your submission was approved - no changes needed" };
  if (submission && submission.decision === "rejected") return { canSubmit: false, reason: "Your submission was not accepted and can't be resubmitted" };
  const overdue = new Date(assignment.dueDate).getTime() < now;
  if (!overdue) return { canSubmit: true };
  const reopened =
    submission && submission.decision === "resubmit" && submission.resubmitUntil && new Date(submission.resubmitUntil).getTime() > now;
  return reopened ? { canSubmit: true } : { canSubmit: false, reason: "The due date for this assignment has passed" };
};

exports.listAssignments = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    if (!req.user.batch) {
      return res.json({ assignments: [], total: 0, page, limit, totalPages: 1 });
    }

    const filter = { batch: req.user.batch };
    const [assignments, total] = await Promise.all([
      Assignment.find(filter).sort({ dueDate: 1 }).skip(skip).limit(limit),
      Assignment.countDocuments(filter),
    ]);
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
                points: submission.points,
                review: submission.review || "",
                reviewedAt: submission.reviewedAt,
                decision: submission.decision || "",
                resubmitUntil: submission.resubmitUntil,
                history: submission.history || [],
              }
            : null,
          status: a.status || "active",
          cancelReason: a.cancelReason || "",
          canSubmit: submitGate(a, submission, now).canSubmit,
          // Locked once the due date has passed and nothing was ever turned in.
          locked: overdue && !submission,
          overdue,
        };
      }),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
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
    const existing = await AssignmentSubmission.findOne({ assignment: assignment._id, student: req.user._id });
    const gate = submitGate(assignment, existing);
    if (!gate.canSubmit) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ message: gate.reason });
    }

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
      // Keep the earlier attempt (file, verdict, points, review) in history, then
      // start the new one as unreviewed.
      existing.history.push({
        fileName: existing.fileName,
        submittedAt: existing.submittedAt,
        decision: existing.decision,
        points: existing.points,
        review: existing.review,
        reviewedAt: existing.reviewedAt,
      });
      Object.assign(existing, payload, {
        points: null,
        review: "",
        reviewedAt: null,
        reviewedBy: null,
        decision: "",
        resubmitUntil: null,
      });
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
