const express = require("express");
const {
  createJob,
  listJobsAdmin,
  updateJob,
  deleteJob,
  listJobInterests,
} = require("../controllers/jobController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.route("/").get(listJobsAdmin).post(createJob);
router.route("/:id").patch(updateJob).delete(deleteJob);
router.get("/:id/interests", listJobInterests);

module.exports = router;
