const express = require("express");
const c = require("../controllers/certificateController");
const { protect, authorize } = require("../middleware/auth");
const { certificateUpload } = require("../utils/upload");

const router = express.Router();

// Public: anyone who scans the QR code can check a certificate is genuine.
router.get("/verify/:code", c.verify);
router.get("/verify/:code/pdf", c.verifyPdf);

router.use(protect, authorize("admin"));

router.get("/templates", c.listTemplates);
router.post("/templates", certificateUpload.single("image"), c.createTemplate);
router.get("/templates/:id", c.getTemplate);
router.patch("/templates/:id", c.updateTemplate);
router.delete("/templates/:id", c.deleteTemplate);
router.post("/templates/:id/preview", c.previewTemplate);

router.post("/issue", c.issue);
router.post("/issue-sheet", c.issueFromSheet);
router.post("/pdf", c.pdfMany);
router.get("/batches", c.listBatches);
router.post("/qr", c.setQr);
router.post("/email", c.emailCertificates);
router.get("/email-jobs/:id", c.emailJobStatus);
router.post("/:id/email", c.emailOne);
router.get("/", c.listCertificates);
router.get("/:id/pdf", c.pdfOne);
router.patch("/:id/revoke", c.revoke);
router.patch("/:id/restore", c.restore);

module.exports = router;
