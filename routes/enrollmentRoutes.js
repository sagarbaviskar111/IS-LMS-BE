const express = require("express");
const { registerStudent, getStudentEnrollment, createStudentLink } = require("../controllers/enrollmentController");
const { getStudentRegistration } = require("../controllers/courseRegistrationController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.post("/register-student", registerStudent);
router.get("/student/:studentId", getStudentEnrollment);
router.get("/student/:studentId/registration", getStudentRegistration);
router.post("/student/:studentId/link", createStudentLink);

module.exports = router;
