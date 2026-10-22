const express = require("express");
const { listJobEmailLeads } = require("../controllers/jobController");
const { protect, authorize } = require("../middleware/auth");
const User = require("../models/User");

const router = express.Router();

router.use(protect, authorize("superadmin"));

router.get("/job-email-leads", listJobEmailLeads);

// Which recording flow (YouTube vs. the institute's own storage server) an
// admin's institute uses is the platform owner's call, not the admin's.
router.patch("/admins/:id/video-flow", async (req, res) => {
  const { flow } = req.body;
  if (!["youtube", "storage"].includes(flow)) {
    return res.status(400).json({ message: "flow must be 'youtube' or 'storage'" });
  }
  try {
    const admin = await User.findOneAndUpdate(
      { _id: req.params.id, role: "admin" },
      { videoFlow: flow },
      { new: true }
    );
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    res.json({ user: admin.toJSON() });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
