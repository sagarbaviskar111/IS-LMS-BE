const express = require("express");
const { modules, list, create, update, remove, activity } = require("../controllers/subadminController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.get("/modules", modules);
router.get("/activity", activity);
router.route("/").get(list).post(create);
router.route("/:id").patch(update).delete(remove);

module.exports = router;
