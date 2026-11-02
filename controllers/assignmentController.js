const { sanitizeRichText } = require("../utils/richText");
const { notifyUsers } = require("../utils/notify");
const fs = require("fs");
const Assignment = require("../models/Assignment");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const User = require("../models/User");
const { uploadFile, deleteFile, resolveResourceType } = require("../utils/cloudinary");
const { withFileUrl, withAttachmentUrl } = require("../utils/fileUrlView");
const paginate = require("../utils/paginate");
const { searchRegex, pickSort, CASE_INSENSITIVE } = require("../utils/listQuery");

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

    const { page, limit, skip } = paginate(req);
    const filter = { batch };
    const rx = searchRegex(req.query.q);
    if (rx) filter.title = rx;
    if (req.query.when === "upcoming") filter.dueDate = { $gte: new Date() };
    if (req.query.when === "past") filter.dueDate = { $lt: new Date() };
    const sort = pickSort(req.query.sort, { due_asc: { dueDate: 1 }, due_desc: { dueDate: -1 }, newest: { createdAt: -1 }, title: { title: 1 } }, "due_asc");

    const [assignments, studentCount, total] = await Promise.all([
      Assignment.find(filter).collation(CASE_INSENSITIVE).sort(sort).skip(skip).limit(limit),
      User.countDocuments({ role: "student", admin: req.user.admin, batch, isActive: true }),
      Assignment.countDocuments(filter),
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
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
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

const DECISION_LABEL = { approved: "approved", resubmit: "sent back for resubmission", rejected: "not accepted" };
const DAY_MS = 24 * 60 * 60 * 1000;

// Teacher reviews one submission: points, a written review and a verdict.
//  decision "approved"  - accepted, no more changes
//  decision "resubmit"  - student must submit again, until resubmitUntil (default 3 days)
//  decision "rejected"  - not accepted and no further attempts
//  decision ""          - clears the verdict
// Every field is optional; points: null clears the grade. The student is notified
// whenever the verdict changes.
exports.reviewSubmission = async (req, res) => {
  try {
    const { assignment, error } = await loadOwnedAssignment(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const submission = await AssignmentSubmission.findOne({ _id: req.params.submissionId, assignment: assignment._id }).catch(
      () => null
    );
    if (!submission) return res.status(404).json({ message: "Submission not found" });

    const { points, review, decision, resubmitUntil } = req.body;
    if (points !== undefined) {
      if (points === null) {
        submission.points = null;
      } else if (typeof points !== "number" || !Number.isFinite(points) || points < 0 || points > 100000) {
        return res.status(400).json({ message: "Points must be a number of 0 or more" });
      } else {
        submission.points = Math.round(points * 100) / 100;
      }
    }
    if (review !== undefined) submission.review = sanitizeRichText(review);

    const previousDecision = submission.decision;
    if (decision !== undefined) {
      if (!["", "approved", "resubmit", "rejected"].includes(decision)) {
        return res.status(400).json({ message: "Invalid decision" });
      }
      if (decision === "resubmit") {
        const until = resubmitUntil ? new Date(resubmitUntil) : new Date(Date.now() + 3 * DAY_MS);
        if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
          return res.status(400).json({ message: "Pick a resubmission deadline in the future" });
        }
        submission.resubmitUntil = until;
      } else {
        submission.resubmitUntil = null;
      }
      submission.decision = decision;
    }

    submission.reviewedAt = new Date();
    submission.reviewedBy = req.user._id;
    await submission.save();

    if (decision && decision !== previousDecision) {
      const extra =
        decision === "resubmit" ? ` Please submit again by ${submission.resubmitUntil.toLocaleString("en-IN")}.` : "";
      await notifyUsers(
        req.user,
        [submission.student],
        `Assignment ${DECISION_LABEL[decision]}`,
        `Your submission for "${assignment.title}" was ${DECISION_LABEL[decision]} by your teacher.${extra}`
      );
    } else if (review !== undefined && submission.review && !decision) {
      await notifyUsers(req.user, [submission.student], "New review on your assignment", `Your teacher reviewed "${assignment.title}".`);
    }

    res.json({ submission: withFileUrl(await submission.populate("student", "name email")) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Teacher cancels an assignment (students can no longer submit) or restores it.
exports.cancelAssignment = async (req, res) => {
  try {
    const { assignment, error } = await loadOwnedAssignment(req);
    if (error) return res.status(error[0]).json({ message: error[1] });
    if (assignment.status === "cancelled") return res.status(400).json({ message: "Already cancelled" });

    assignment.status = "cancelled";
    assignment.cancelReason = String((req.body && req.body.reason) || "").trim().slice(0, 300);
    assignment.cancelledAt = new Date();
    await assignment.save();

    const students = await User.find({ role: "student", batch: assignment.batch, isActive: true }).select("_id");
    await notifyUsers(
      req.user,
      students.map((u) => u._id),
      "Assignment cancelled",
      `"${assignment.title}" was cancelled by your teacher.${assignment.cancelReason ? ` Reason: ${assignment.cancelReason}` : ""}`
    );
    res.json({ assignment: serializeAssignment(assignment) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.restoreAssignment = async (req, res) => {
  try {
    const { assignment, error } = await loadOwnedAssignment(req);
    if (error) return res.status(error[0]).json({ message: error[1] });
    if (assignment.status !== "cancelled") return res.status(400).json({ message: "Assignment isn't cancelled" });

    assignment.status = "active";
    assignment.cancelReason = "";
    assignment.cancelledAt = null;
    await assignment.save();

    const students = await User.find({ role: "student", batch: assignment.batch, isActive: true }).select("_id");
    await notifyUsers(req.user, students.map((u) => u._id), "Assignment restored", `"${assignment.title}" is active again.`);
    res.json({ assignment: serializeAssignment(assignment) });
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
