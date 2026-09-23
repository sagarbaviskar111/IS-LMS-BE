const Exam = require("../models/Exam");
const Submission = require("../models/Submission");

exports.listExams = async (req, res) => {
  try {
    if (!req.user.batch) return res.json({ exams: [] });

    const exams = await Exam.find({
      batch: req.user.batch,
      status: { $in: ["published", "closed"] },
    }).sort({ createdAt: -1 });

    const submissions = await Submission.find({
      exam: { $in: exams.map((e) => e._id) },
      student: req.user._id,
    });
    const submissionByExam = new Map(submissions.map((s) => [String(s.exam), s]));

    res.json({
      exams: exams.map((e) => {
        const submission = submissionByExam.get(String(e._id));
        return {
          _id: e._id,
          title: e.title,
          description: e.description,
          status: e.status,
          resultsAnnounced: e.resultsAnnounced,
          questionCount: e.questions.length,
          totalMarks: e.questions.reduce((sum, q) => sum + q.marks, 0),
          submitted: !!submission,
          score: e.resultsAnnounced && submission ? submission.score : null,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getExam = async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ message: "Exam not found" });
    if (!req.user.batch || String(exam.batch) !== String(req.user.batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (exam.status === "draft") {
      return res.status(403).json({ message: "This exam isn't published yet" });
    }

    const existingSubmission = await Submission.findOne({ exam: exam._id, student: req.user._id });

    if (existingSubmission) {
      return res.json({
        exam: { _id: exam._id, title: exam.title, description: exam.description, status: exam.status },
        alreadySubmitted: true,
        resultsAnnounced: exam.resultsAnnounced,
      });
    }

    if (exam.status !== "published") {
      return res.status(403).json({ message: "This exam is closed" });
    }

    res.json({
      exam: {
        _id: exam._id,
        title: exam.title,
        description: exam.description,
        status: exam.status,
        questions: exam.questions.map((q) => ({
          _id: q._id,
          text: q.text,
          options: q.options,
          marks: q.marks,
        })),
      },
      alreadySubmitted: false,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.submitExam = async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ message: "Exam not found" });
    if (!req.user.batch || String(exam.batch) !== String(req.user.batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (exam.status !== "published") {
      return res.status(400).json({ message: "This exam is not open for submissions" });
    }

    const existing = await Submission.findOne({ exam: exam._id, student: req.user._id });
    if (existing) {
      return res.status(409).json({ message: "You've already submitted this exam" });
    }

    const { answers } = req.body;
    if (!Array.isArray(answers)) {
      return res.status(400).json({ message: "answers must be an array" });
    }

    const answerMap = new Map(answers.map((a) => [String(a.question), a.selectedOptionIndex]));

    let score = 0;
    let totalMarks = 0;
    const gradedAnswers = [];
    for (const q of exam.questions) {
      totalMarks += q.marks;
      const selected = answerMap.get(String(q._id));
      if (selected !== undefined) {
        gradedAnswers.push({ question: q._id, selectedOptionIndex: selected });
        if (selected === q.correctOptionIndex) score += q.marks;
      }
    }

    const submission = await Submission.create({
      exam: exam._id,
      student: req.user._id,
      batch: exam.batch,
      answers: gradedAnswers,
      score,
      totalMarks,
    });

    res.status(201).json({ message: "Submitted", submissionId: submission._id });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "You've already submitted this exam" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.getResult = async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ message: "Exam not found" });
    if (!req.user.batch || String(exam.batch) !== String(req.user.batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (!exam.resultsAnnounced) {
      return res.status(403).json({ message: "Results haven't been announced yet" });
    }

    const submission = await Submission.findOne({ exam: exam._id, student: req.user._id });
    if (!submission) return res.status(404).json({ message: "You didn't submit this exam" });

    const answerMap = new Map(submission.answers.map((a) => [String(a.question), a.selectedOptionIndex]));

    res.json({
      score: submission.score,
      totalMarks: submission.totalMarks,
      questions: exam.questions.map((q) => ({
        _id: q._id,
        text: q.text,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
        selectedOptionIndex: answerMap.has(String(q._id)) ? answerMap.get(String(q._id)) : null,
        marks: q.marks,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
