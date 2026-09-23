const express = require("express");
const { listMyBatches, listBatchStudents, batchNetwork, youtubeStatus } = require("../controllers/teacherController");
const {
  createSession,
  createBulkSessions,
  listSessions,
  updateSession,
  deleteSession,
} = require("../controllers/sessionController");
const {
  getSessionAttendance,
  markSessionAttendance,
  batchAttendanceSummary,
} = require("../controllers/attendanceController");
const { uploadMaterial, listMaterials, deleteMaterial } = require("../controllers/materialController");
const {
  createExam,
  listExams,
  getExam,
  updateExam,
  deleteExam,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  publishExam,
  closeExam,
  announceResults,
  listSubmissions,
} = require("../controllers/examController");
const {
  createAssignment,
  listAssignments,
  getAssignment,
  updateAssignment,
  deleteAssignment,
  listSubmissions: listAssignmentSubmissions,
} = require("../controllers/assignmentController");
const { upload, assignmentUpload } = require("../utils/upload");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("teacher"));

router.get("/youtube-status", youtubeStatus);

router.get("/batches", listMyBatches);
router.get("/batches/:id/students", listBatchStudents);
router.get("/batches/:id/attendance-summary", batchAttendanceSummary);
router.get("/batches/:id/network", batchNetwork);

router.get("/sessions", listSessions);
router.post("/sessions", createSession);
router.post("/sessions/bulk", createBulkSessions);
router.patch("/sessions/:id", updateSession);
router.delete("/sessions/:id", deleteSession);

router.get("/sessions/:id/attendance", getSessionAttendance);
router.put("/sessions/:id/attendance", markSessionAttendance);

router.get("/materials", listMaterials);
router.post("/materials", upload.single("file"), uploadMaterial);
router.delete("/materials/:id", deleteMaterial);

router.get("/exams", listExams);
router.post("/exams", createExam);
router.get("/exams/:id", getExam);
router.patch("/exams/:id", updateExam);
router.delete("/exams/:id", deleteExam);
router.post("/exams/:id/questions", addQuestion);
router.patch("/exams/:id/questions/:qid", updateQuestion);
router.delete("/exams/:id/questions/:qid", deleteQuestion);
router.patch("/exams/:id/publish", publishExam);
router.patch("/exams/:id/close", closeExam);
router.patch("/exams/:id/announce", announceResults);
router.get("/exams/:id/submissions", listSubmissions);

router.get("/assignments", listAssignments);
router.post("/assignments", assignmentUpload.single("file"), createAssignment);
router.get("/assignments/:id", getAssignment);
router.patch("/assignments/:id", updateAssignment);
router.delete("/assignments/:id", deleteAssignment);
router.get("/assignments/:id/submissions", listAssignmentSubmissions);

module.exports = router;
