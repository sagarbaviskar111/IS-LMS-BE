const express = require("express");
const {
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  getTeamSettings,
  updateTeamSettings,
  getEmailSettings,
  updateEmailSettings,
  getLeadWebhookSettings,
  regenerateLeadWebhookKey,
} = require("../controllers/userController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect, authorize("superadmin", "admin"));

router
  .route("/team-settings")
  .get(authorize("admin"), getTeamSettings)
  .patch(authorize("admin"), updateTeamSettings);

// Both admin (their institute) and superadmin (their own account) send
// password-reset email through their own Gmail sender.
router.route("/email-settings").get(getEmailSettings).patch(updateEmailSettings);

router.get("/lead-webhook", authorize("admin"), getLeadWebhookSettings);
router.post("/lead-webhook/regenerate", authorize("admin"), regenerateLeadWebhookKey);

router.route("/").get(listUsers).post(createUser);
router.route("/:id").get(getUser).patch(updateUser).delete(deleteUser);

module.exports = router;
