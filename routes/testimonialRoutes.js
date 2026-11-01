const express = require("express");
const c = require("../controllers/testimonialController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Public: the landing page reads these.
router.get("/", c.publicList);

// Superadmin only: manage them.
router.use(protect, authorize("superadmin"));
router.get("/manage", c.manageList);
router.post("/import", c.importDefaults);
router.post("/", c.create);
router.patch("/:id", c.update);
router.delete("/:id", c.remove);

module.exports = router;
