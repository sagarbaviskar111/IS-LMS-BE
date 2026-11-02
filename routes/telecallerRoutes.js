const express = require("express");
const leadStudent = require("../controllers/leadStudentController");
const {
  listMyLeads,
  setFollowUp,
  leadSummary,
  getQuickMessages,
  saveQuickMessages,
  deleteMyInvalidLeads,
  mySourceOptions,
  getLead,
  logCall,
  registerLead,
  generateRegistrationLink,
} = require("../controllers/telecallerLeadController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("telecaller"));

router.get("/quick-messages", getQuickMessages);
router.put("/quick-messages", saveQuickMessages);
router.get("/leads", listMyLeads);
router.get("/leads/sources", mySourceOptions);
router.get("/leads/summary", leadSummary);
router.post("/leads/invalid/delete", deleteMyInvalidLeads);
router.get("/leads/:id", getLead);
router.post("/leads/:id/calls", logCall);
router.patch("/leads/:id/follow-up", setFollowUp);
router.post("/leads/:id/register", registerLead);
router.post("/leads/:id/register-student", leadStudent.telecaller.registerLeadStudent);
router.get("/leads/:id/enrollment", leadStudent.telecaller.getLeadEnrollment);
router.post("/leads/:id/enrollment-link", leadStudent.telecaller.createLeadEnrollmentLink);
router.get("/courses", leadStudent.telecallerCourses);
router.post("/leads/:id/registration-link", generateRegistrationLink);

module.exports = router;
