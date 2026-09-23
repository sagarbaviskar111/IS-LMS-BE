const express = require("express");
const {
  createLead,
  listLeads,
  getLead,
  reassignLead,
  registerLead,
  generateRegistrationLink,
} = require("../controllers/leadController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("admin"));

router.get("/", listLeads);
router.post("/", createLead);
router.get("/:id", getLead);
router.patch("/:id/assign", reassignLead);
router.post("/:id/register", registerLead);
router.post("/:id/registration-link", generateRegistrationLink);

module.exports = router;
