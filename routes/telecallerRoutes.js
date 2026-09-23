const express = require("express");
const {
  listMyLeads,
  getLead,
  logCall,
  registerLead,
  generateRegistrationLink,
} = require("../controllers/telecallerLeadController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("telecaller"));

router.get("/leads", listMyLeads);
router.get("/leads/:id", getLead);
router.post("/leads/:id/calls", logCall);
router.post("/leads/:id/register", registerLead);
router.post("/leads/:id/registration-link", generateRegistrationLink);

module.exports = router;
