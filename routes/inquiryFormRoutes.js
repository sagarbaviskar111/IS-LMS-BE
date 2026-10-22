const express = require("express");
const {
  createForm,
  listForms,
  getForm,
  updateForm,
  deleteForm,
  listResponses,
  exportResponses,
  deleteResponse,
  addResponseToLead,
  getPublicForm,
  submitPublicForm,
} = require("../controllers/inquiryFormController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Public — what a student sees when they open the shared link.
router.get("/public/:slug/:formKey", getPublicForm);
router.post("/public/:slug/:formKey", submitPublicForm);

router.use(protect);

// Read + add-to-leads: the admin and their callers (telecallers).
const staff = authorize("admin", "telecaller");
router.get("/", staff, listForms);
router.get("/:id", staff, getForm);
router.get("/:id/responses", staff, listResponses);
router.post("/:id/responses/:responseId/lead", staff, addResponseToLead);

// Everything that changes or exports the form itself: admin only.
router.post("/", authorize("admin"), createForm);
router.patch("/:id", authorize("admin"), updateForm);
router.delete("/:id", authorize("admin"), deleteForm);
router.get("/:id/responses/export", authorize("admin"), exportResponses);
router.delete("/:id/responses/:responseId", authorize("admin"), deleteResponse);

module.exports = router;
