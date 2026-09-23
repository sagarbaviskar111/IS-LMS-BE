const express = require("express");
const {
  createGroup,
  listGroups,
  updateGroup,
  deleteGroup,
} = require("../controllers/studentGroupController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.route("/").get(listGroups).post(createGroup);
router.route("/:id").patch(updateGroup).delete(deleteGroup);

module.exports = router;
