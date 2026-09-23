const Exam = require("../models/Exam");
const Submission = require("../models/Submission");

const isAssigned = (req, batchId) =>
  (req.user.batches || []).some((b) => String(b) === String(batchId));

const loadOwnedExam = async (req) => {
  const exam = await Exam.findById(req.params.id);
  if (!exam) return { error: [404, "Exam not found"] };
  if (!isAssigned(req, exam.batch)) return { error: [403, "Not authorized"] };
  return { exam };
};

const summarize = (exam) => ({
  _id: exam._id,
  batch: exam.batch,
  title: exam.title,
  description: exam.description,
  status: exam.status,
  resultsAnnounced: exam.resultsAnnounced,
  questionCount: exam.questions.length,
  totalMarks: exam.questions.reduce((sum, q) => sum + q.marks, 0),
  createdAt: exam.createdAt,
  updatedAt: exam.updatedAt,
});

exports.createExam = async (req, res) => {
  try {
    const { batch, title, description } = req.body;
    if (!batch || !title) {
      return res.status(400).json({ message: "batch and title are required" });
    }
    if (!isAssigned(req, batch)) {
      return res.status(403).json({ message: "You are not assigned to this batch" });
    }

    const exam = await Exam.create({ batch, admin: req.user.admin, createdBy: req.user._id, title, description });
    res.status(201).json({ exam: summarize(exam) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listExams = async (req, res) => {
  try {
    const { batch } = req.query;
    if (!batch) return res.status(400).json({ message: "batch is required" });
    if (!isAssigned(req, batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const exams = await Exam.find({ batch }).sort({ createdAt: -1 });
    res.json({ exams: exams.map(summarize) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getExam = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });
    res.json({ exam });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateExam = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const { title, description } = req.body;
    if (title !== undefined) exam.title = title;
    if (description !== undefined) exam.description = description;

    await exam.save();
    res.json({ exam });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteExam = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    if (exam.status !== "draft") {
      return res.status(400).json({ message: "Only draft exams can be deleted" });
    }

    await exam.deleteOne();
    res.json({ message: "Exam deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.addQuestion = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    if (exam.status !== "draft") {
      return res.status(400).json({ message: "Can only edit questions while the exam is a draft" });
    }

    const { text, options, correctOptionIndex, marks } = req.body;
    if (!text || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ message: "text and at least 2 options are required" });
    }
    if (
      typeof correctOptionIndex !== "number" ||
      correctOptionIndex < 0 ||
      correctOptionIndex >= options.length
    ) {
      return res.status(400).json({ message: "correctOptionIndex must point to a valid option" });
    }

    exam.questions.push({ text, options, correctOptionIndex, marks: marks || 1 });
    await exam.save();
    res.status(201).json({ exam });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateQuestion = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    if (exam.status !== "draft") {
      return res.status(400).json({ message: "Can only edit questions while the exam is a draft" });
    }

    const question = exam.questions.id(req.params.qid);
    if (!question) return res.status(404).json({ message: "Question not found" });

    const { text, options, correctOptionIndex, marks } = req.body;
    if (text !== undefined) question.text = text;
    if (options !== undefined) question.options = options;
    if (correctOptionIndex !== undefined) question.correctOptionIndex = correctOptionIndex;
    if (marks !== undefined) question.marks = marks;

    if (question.correctOptionIndex < 0 || question.correctOptionIndex >= question.options.length) {
      return res.status(400).json({ message: "correctOptionIndex must point to a valid option" });
    }

    await exam.save();
    res.json({ exam });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteQuestion = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    if (exam.status !== "draft") {
      return res.status(400).json({ message: "Can only edit questions while the exam is a draft" });
    }

    const question = exam.questions.id(req.params.qid);
    if (!question) return res.status(404).json({ message: "Question not found" });

    question.deleteOne();
    await exam.save();
    res.json({ exam });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.publishExam = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    if (exam.status !== "draft") {
      return res.status(400).json({ message: "Exam is already published" });
    }
    if (exam.questions.length === 0) {
      return res.status(400).json({ message: "Add at least one question before publishing" });
    }

    exam.status = "published";
    await exam.save();
    res.json({ exam });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.closeExam = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    if (exam.status !== "published") {
      return res.status(400).json({ message: "Only a published exam can be closed" });
    }

    exam.status = "closed";
    await exam.save();
    res.json({ exam });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.announceResults = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    if (exam.status !== "closed") {
      return res.status(400).json({ message: "Close the exam before announcing results" });
    }

    exam.resultsAnnounced = true;
    await exam.save();
    res.json({ exam });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listSubmissions = async (req, res) => {
  try {
    const { exam, error } = await loadOwnedExam(req);
    if (error) return res.status(error[0]).json({ message: error[1] });

    const submissions = await Submission.find({ exam: exam._id })
      .populate("student", "name email")
      .sort({ score: -1 });

    res.json({ submissions });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
