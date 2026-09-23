const express = require("express");
const {
  createBatch,
  listBatches,
  updateBatch,
  updateBatchMembers,
  deleteBatch,
} = require("../controllers/batchController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.route("/").get(listBatches).post(createBatch);
router.route("/:id").patch(updateBatch).delete(deleteBatch);
router.patch("/:id/members", updateBatchMembers);

module.exports = router;
