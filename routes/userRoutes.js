const express = require("express");
const {
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
} = require("../controllers/userController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("superadmin", "admin"));

router.route("/").get(listUsers).post(createUser);
router.route("/:id").get(getUser).patch(updateUser).delete(deleteUser);

module.exports = router;
