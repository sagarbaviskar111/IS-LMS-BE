const express = require("express");
const {
  myBatch,
  listSessions,
  myAttendance,
  classmates,
  listMaterials,
  myPayments,
} = require("../controllers/studentController");
const { listExams, getExam, submitExam, getResult } = require("../controllers/studentExamController");
const { listAssignments, submitAssignment } = require("../controllers/studentAssignmentController");
const { assignmentUpload } = require("../utils/upload");
const { listMyInstituteTools } = require("../controllers/toolController");
const { listJobsForStudent, expressInterest } = require("../controllers/jobController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("student"));

router.get("/tools", listMyInstituteTools);
router.get("/jobs", listJobsForStudent);
router.post("/jobs/:id/interest", expressInterest);
router.get("/batch", myBatch);
router.get("/sessions", listSessions);
router.get("/attendance", myAttendance);
router.get("/classmates", classmates);
router.get("/materials", listMaterials);
router.get("/payments", myPayments);

router.get("/exams", listExams);
router.get("/exams/:id", getExam);
router.post("/exams/:id/submit", submitExam);
router.get("/exams/:id/result", getResult);

router.get("/assignments", listAssignments);
router.post("/assignments/:id/submit", assignmentUpload.single("file"), submitAssignment);

module.exports = router;
