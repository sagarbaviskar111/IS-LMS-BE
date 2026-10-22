const express = require("express");
const { createCourse, listCourses, updateCourse, deleteCourse } = require("../controllers/courseController");
const { listCourseRegistrations, getRegistrationFile } = require("../controllers/courseRegistrationController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.route("/").get(listCourses).post(createCourse);
router.get("/registrations/:regId/file/:kind", getRegistrationFile);
router.get("/:id/registrations", listCourseRegistrations);
router.route("/:id").patch(updateCourse).delete(deleteCourse);

module.exports = router;
