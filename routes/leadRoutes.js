const express = require("express");
const {
  createLead,
  listLeads,
  getLead,
  reassignLead,
  registerLead,
  generateRegistrationLink,
  ingestWebhookLead,
  leadSourceOptions,
  bulkCreateLeads,
  deleteInvalidLeads,
} = require("../controllers/leadController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Public — hit directly by external sources, authenticated by the key in
// the URL rather than a session. Must be registered before the protect
// middleware below.
router.post("/webhook/:apiKey", ingestWebhookLead);

router.use(protect, authorize("admin"));

router.get("/", listLeads);
router.get("/sources", leadSourceOptions);
router.post("/", createLead);
router.post("/bulk", bulkCreateLeads);
router.post("/invalid/delete", deleteInvalidLeads);
router.get("/:id", getLead);
router.patch("/:id/assign", reassignLead);
router.post("/:id/register", registerLead);
router.post("/:id/registration-link", generateRegistrationLink);

module.exports = router;
