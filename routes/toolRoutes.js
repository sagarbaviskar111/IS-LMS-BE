const express = require("express");
const { createTool, listTools, updateTool, deleteTool } = require("../controllers/toolController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.route("/").get(listTools).post(createTool);
router.route("/:id").patch(updateTool).delete(deleteTool);

module.exports = router;
