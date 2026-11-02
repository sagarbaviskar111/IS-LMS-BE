const fs = require("fs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const Certificate = require("../models/Certificate");
const CertificateTemplate = require("../models/CertificateTemplate");
const CertificateBatch = require("../models/CertificateBatch");
const User = require("../models/User");
const Batch = require("../models/Batch");
const Course = require("../models/Course");
const { uploadFile, deleteFile, getFileUrl } = require("../utils/cloudinary");
const { buildPdf } = require("../utils/certificatePdf");
const { shapeInstitute } = require("../utils/institute");
const { notifyUsers } = require("../utils/notify");
const { sendCertificateEmail } = require("../utils/email");
const paginate = require("../utils/paginate");

const FIELD_KEYS = ["student_name", "certificate_no", "course", "date", "grade", "batch", "institute_name", "custom"];
const FONTS = ["helvetica", "times", "courier", "unicode"];
const MAX_FIELDS = 20;
const MAX_BULK = 200;
const MAX_PDF_BATCH = 100;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};
const verifyUrlFor = (code) =>
  `${(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "")}/verify/${code}`;
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "certificate";

const dropUpload = (file) => {
  if (file) fs.unlink(file.path, () => {});
};

// ---- template field validation ---------------------------------------------

const readFields = (raw) => {
  if (!Array.isArray(raw)) return { error: "fields must be a list" };
  if (raw.length > MAX_FIELDS) return { error: `At most ${MAX_FIELDS} fields per certificate` };
  const out = [];
  for (const f of raw) {
    if (!f || !FIELD_KEYS.includes(f.key)) return { error: "Unknown field type" };
    const text = String(f.text || "").trim().slice(0, 200);
    if (f.key === "custom" && !text) return { error: "A custom text field can't be empty" };
    out.push({
      ...(f._id && mongoose.isValidObjectId(f._id) ? { _id: f._id } : {}),
      key: f.key,
      text: f.key === "custom" ? text : "",
      x: clamp(f.x, 0, 100, 50),
      y: clamp(f.y, 0, 100, 50),
      fontSize: clamp(f.fontSize, 0.5, 20, 3),
      maxWidth: clamp(f.maxWidth, 0, 100, 0),
      color: /^#[0-9a-fA-F]{6}$/.test(f.color || "") ? f.color : "#111111",
      align: ["left", "center", "right"].includes(f.align) ? f.align : "center",
      font: FONTS.includes(f.font) ? f.font : "helvetica",
      bold: !!f.bold,
      italic: !!f.italic,
      transform: ["none", "upper", "title"].includes(f.transform) ? f.transform : "none",
    });
  }
  return { value: out };
};

const readQr = (raw) => ({
  enabled: raw?.enabled !== false,
  x: clamp(raw?.x, 0, 100, 90),
  y: clamp(raw?.y, 0, 100, 85),
  size: clamp(raw?.size, 3, 30, 9),
});

const readPrefix = (raw) => String(raw ?? "").trim().replace(/[^A-Za-z0-9/_-]/g, "").slice(0, 20);

const shapeTemplate = (t, issued) => ({
  _id: t._id,
  name: t.name,
  imageUrl: getFileUrl(t.image.cloudinaryPublicId, t.image.cloudinaryResourceType),
  width: t.image.width,
  height: t.image.height,
  fields: t.fields,
  qr: t.qr,
  numbering: t.numbering,
  archived: t.archived,
  issued: issued ?? undefined,
  createdAt: t.createdAt,
});

const issuedCounts = async (adminId) => {
  const rows = await Certificate.aggregate([{ $match: { admin: adminId } }, { $group: { _id: "$template", n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
};

const ownTemplate = (req) =>
  CertificateTemplate.findOne({ _id: req.params.id, admin: req.user._id }).catch(() => null);

// ---- templates --------------------------------------------------------------

exports.listTemplates = async (req, res) => {
  try {
    const [templates, counts] = await Promise.all([
      CertificateTemplate.find({ admin: req.user._id }).sort({ createdAt: -1 }),
      issuedCounts(req.user._id),
    ]);
    res.json({ templates: templates.map((t) => shapeTemplate(t, counts.get(String(t._id)) || 0)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getTemplate = async (req, res) => {
  try {
    const t = await ownTemplate(req);
    if (!t) return res.status(404).json({ message: "Template not found" });
    res.json({ template: shapeTemplate(t) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// The prefix must be unique per institute, otherwise two templates could hand
// out the same certificate number.
const prefixTaken = (adminId, prefix, exceptId) =>
  CertificateTemplate.exists({
    admin: adminId,
    "numbering.prefix": prefix,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });

exports.createTemplate = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "Upload the certificate image (PNG or JPG)" });
    const name = String(req.body.name || "").trim().slice(0, 80);
    if (!name) {
      dropUpload(req.file);
      return res.status(400).json({ message: "Give the template a name" });
    }

    let prefix = readPrefix(req.body.prefix);
    if (!prefix) {
      const base = (req.user.instituteSlug || req.user.name || "CERT").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
      prefix = base || "CERT";
    }
    if (await prefixTaken(req.user._id, prefix)) {
      // Auto-suffix a default so a second template needs no extra thought.
      let n = 2;
      while (await prefixTaken(req.user._id, `${prefix}${n}`)) n += 1;
      if (req.body.prefix) {
        dropUpload(req.file);
        return res.status(409).json({ message: "That certificate number prefix is already used by another template" });
      }
      prefix = `${prefix}${n}`;
    }

    let up;
    try {
      up = await uploadFile(req.file.path, { folder: `certificates/${req.user._id}`, resourceType: "image" });
    } finally {
      dropUpload(req.file);
    }

    const template = await CertificateTemplate.create({
      admin: req.user._id,
      name,
      image: {
        cloudinaryPublicId: up.public_id,
        cloudinaryResourceType: up.resource_type,
        width: up.width,
        height: up.height,
      },
      // A sensible starting layout so the editor never opens empty.
      fields: [
        { key: "student_name", x: 50, y: 48, fontSize: 4.5, maxWidth: 70, font: "times", bold: true, align: "center" },
        { key: "course", x: 50, y: 62, fontSize: 2.4, maxWidth: 70, align: "center" },
        { key: "date", x: 20, y: 85, fontSize: 1.8, align: "center" },
        { key: "certificate_no", x: 50, y: 92, fontSize: 1.5, align: "center" },
      ],
      numbering: { prefix },
    });
    res.status(201).json({ template: shapeTemplate(template, 0) });
  } catch (err) {
    dropUpload(req.file);
    res.status(500).json({ message: "Could not save the template" });
  }
};

exports.updateTemplate = async (req, res) => {
  try {
    const t = await ownTemplate(req);
    if (!t) {
      dropUpload(req.file);
      return res.status(404).json({ message: "Template not found" });
    }
    const b = req.body || {};

    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 80);
      if (!name) return res.status(400).json({ message: "Give the template a name" });
      t.name = name;
    }
    if (b.fields !== undefined) {
      const { value, error } = readFields(b.fields);
      if (error) return res.status(400).json({ message: error });
      t.fields = value;
    }
    if (b.qr !== undefined) t.qr = readQr(b.qr);
    if (b.numbering !== undefined) {
      const prefix = readPrefix(b.numbering.prefix);
      if (!prefix) return res.status(400).json({ message: "Enter a certificate number prefix" });
      if (prefix !== t.numbering.prefix && (await prefixTaken(req.user._id, prefix, t._id))) {
        return res.status(409).json({ message: "That prefix is already used by another template" });
      }
      t.numbering.prefix = prefix;
      t.numbering.includeYear = b.numbering.includeYear !== false;
      t.numbering.padding = clamp(b.numbering.padding, 1, 8, 4);
    }
    if (b.archived !== undefined) t.archived = !!b.archived;
    await t.save();
    res.json({ template: shapeTemplate(t) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteTemplate = async (req, res) => {
  try {
    const t = await ownTemplate(req);
    if (!t) return res.status(404).json({ message: "Template not found" });
    const issued = await Certificate.countDocuments({ template: t._id });
    if (issued > 0) {
      t.archived = true;
      await t.save();
      return res.json({ message: "Template archived (certificates were issued with it)", archived: true });
    }
    await t.deleteOne();
    await deleteFile(t.image.cloudinaryPublicId, t.image.cloudinaryResourceType);
    res.json({ message: "Template deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const sendPdf = (res, buffer, filename) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
};

// A test PDF with sample data. Accepts unsaved fields/qr so the editor can
// check the real rendering before the admin commits to a layout.
exports.previewTemplate = async (req, res) => {
  try {
    const t = await ownTemplate(req);
    if (!t) return res.status(404).json({ message: "Template not found" });
    const b = req.body || {};
    const draft = t.toObject();
    if (b.fields !== undefined) {
      const { value, error } = readFields(b.fields);
      if (error) return res.status(400).json({ message: error });
      draft.fields = value;
    }
    if (b.qr !== undefined) draft.qr = readQr(b.qr);

    const year = new Date().getFullYear();
    const no = [draft.numbering.prefix, ...(draft.numbering.includeYear ? [year] : []), "1".padStart(draft.numbering.padding, "0")].join("/");
    const pdf = await buildPdf([
      {
        template: draft,
        certificateNo: no,
        verifyUrl: verifyUrlFor("SAMPLE"),
        values: {
          student_name: "Aarav Sharma",
          course: "Full Stack Web Development",
          batch: "Morning Batch",
          grade: "A+",
          institute_name: req.user.name,
          date: new Date(),
        },
      },
    ]);
    sendPdf(res, pdf, "certificate-preview.pdf");
  } catch (err) {
    console.error("[certificate] preview failed:", err.message);
    res.status(500).json({ message: "Could not render the preview" });
  }
};

// ---- issuing ---------------------------------------------------------------

const courseNameOf = async (student, batchById, courseById) => {
  if (student.course) return courseById.get(String(student.course)) || "";
  const batch = student.batch ? batchById.get(String(student.batch)) : null;
  return batch?.course ? courseById.get(String(batch.course)) || "" : "";
};

// What the admin chose on the issue form besides who gets it:
// a name for a certificate batch (empty = no batch), whether the QR code is
// drawn, and whether to email everyone right after issuing.
const readIssueOptions = (b) => ({
  batchName: String(b?.batchName || "").trim().slice(0, 100),
  qrEnabled: b?.qrEnabled !== false,
  sendEmail: !!b?.sendEmail,
});

// Shared by the pick-students and upload-sheet paths.
// entries: [{ student (User|null), name, email, phone, course, batch, grade, date (Date), certificateNo? }]
const issueEntries = async (req, template, entries, allowDuplicate, options = {}) => {
  const skipped = [];
  const rows = [];
  for (const e of entries) {
    if (!allowDuplicate) {
      const filter = { template: template._id, status: "active", "values.course": e.course };
      if (e.student) filter.student = e.student._id;
      else Object.assign(filter, { student: null, "values.student_name": e.name });
      if (await Certificate.exists(filter)) {
        skipped.push({ studentId: e.student?._id || null, name: e.name, reason: "Already has this certificate" });
        continue;
      }
    }
    rows.push(e);
  }
  if (!rows.length) return { certificates: [], skipped, batch: null };

  const batch = options.batchName
    ? await CertificateBatch.create({
        admin: req.user._id,
        name: options.batchName,
        template: template._id,
        createdBy: req.user._id,
      })
    : null;

  // Reserve a block of numbers atomically so concurrent bulk runs never clash.
  const autoCount = rows.filter((r) => !r.certificateNo).length;
  let start = 0;
  if (autoCount) {
    const bumped = await CertificateTemplate.findOneAndUpdate(
      { _id: template._id },
      { $inc: { "numbering.counter": autoCount } },
      { returnDocument: "after" }
    );
    start = bumped.numbering.counter - autoCount + 1;
  }
  let n = 0;
  const numberFor = (r) =>
    r.certificateNo ||
    [
      template.numbering.prefix,
      ...(template.numbering.includeYear ? [r.date.getFullYear()] : []),
      String(start + n++).padStart(template.numbering.padding, "0"),
    ].join("/");

  const docs = rows.map((r) => ({
    admin: req.user._id,
    template: template._id,
    student: r.student?._id || null,
    recipient: { email: r.email || "", phone: r.phone || "" },
    certificateNo: numberFor(r),
    verifyCode: crypto.randomBytes(6).toString("hex"),
    values: {
      student_name: r.name,
      course: r.course,
      batch: r.batch || "",
      grade: r.grade || "",
      institute_name: req.user.name,
      date: r.date,
    },
    batch: batch?._id || null,
    qrEnabled: options.qrEnabled !== false,
    issuedBy: req.user._id,
  }));

  let created;
  try {
    created = await Certificate.insertMany(docs);
  } catch (err) {
    // Don't leave an empty batch behind when nothing was issued.
    if (batch) await batch.deleteOne().catch(() => {});
    throw err;
  }
  await notifyUsers(
    req.user,
    created.map((c) => c.student).filter(Boolean),
    "Certificate issued",
    "Your certificate is ready. You can download it from My Certificates."
  );
  const shaped = created.map((c) => shapeCert(c, template.name));
  if (batch) shaped.forEach((c) => ((c.batchId = batch._id), (c.batchName = batch.name)));
  return {
    certificates: shaped,
    skipped,
    batch: batch ? { _id: batch._id, name: batch.name } : null,
    createdIds: created.map((c) => c._id),
  };
};

// After issuing: start emailing everyone if the admin asked for it.
const maybeStartEmails = (req, out, options) => {
  if (!options.sendEmail || !out.createdIds?.length) return null;
  const started = startEmailJob(req.user, out.createdIds, { resend: false });
  return started.error ? { error: started.error } : { jobId: started.jobId, total: out.createdIds.length };
};

const dupNumber = (err) => err?.code === 11000 && /certificateNo/.test(err.message || "");

const findTemplate = (req) =>
  CertificateTemplate.findOne({ _id: req.body?.templateId, admin: req.user._id, archived: false }).catch(() => null);

exports.issue = async (req, res) => {
  try {
    const b = req.body || {};
    const template = await findTemplate(req);
    if (!template) return res.status(404).json({ message: "Template not found" });

    const ids = [...new Set((Array.isArray(b.studentIds) ? b.studentIds : []).map(String))].filter((i) =>
      mongoose.isValidObjectId(i)
    );
    if (!ids.length) return res.status(400).json({ message: "Select at least one student" });
    if (ids.length > MAX_BULK) return res.status(400).json({ message: `Issue at most ${MAX_BULK} certificates at a time` });

    const date = b.date ? new Date(b.date) : new Date();
    if (Number.isNaN(date.getTime())) return res.status(400).json({ message: "Enter a valid date" });
    const grade = String(b.grade || "").trim().slice(0, 40);
    const courseOverride = String(b.course || "").trim().slice(0, 120);
    const manualNo = String(b.certificateNo || "").trim().slice(0, 40);
    if (manualNo && ids.length !== 1) {
      return res.status(400).json({ message: "A custom certificate number works for one student at a time" });
    }

    const students = await User.find({ _id: { $in: ids }, admin: req.user._id, role: "student" }).select(
      "name email phone course batch"
    );
    if (!students.length) return res.status(404).json({ message: "No matching students found" });

    const [batches, courses] = await Promise.all([
      Batch.find({ _id: { $in: students.map((s) => s.batch).filter(Boolean) } }).select("name course"),
      Course.find({ admin: req.user._id }).select("name"),
    ]);
    const batchById = new Map(batches.map((x) => [String(x._id), x]));
    const courseById = new Map(courses.map((c) => [String(c._id), c.name]));

    const entries = [];
    for (const s of students) {
      entries.push({
        student: s,
        name: s.name,
        email: s.email,
        phone: s.phone,
        course: courseOverride || (await courseNameOf(s, batchById, courseById)),
        batch: batchById.get(String(s.batch))?.name || "",
        grade,
        date,
        certificateNo: manualNo,
      });
    }

    const options = readIssueOptions(b);
    const out = await issueEntries(req, template, entries, !!b.allowDuplicate, options);
    if (!out.certificates.length) return res.status(409).json({ message: "Nothing to issue", skipped: out.skipped });
    const emailJob = maybeStartEmails(req, out, options);
    delete out.createdIds;
    res.status(201).json({ ...out, emailJob });
  } catch (err) {
    if (dupNumber(err)) return res.status(409).json({ message: "That certificate number already exists - choose another" });
    console.error("[certificate] issue failed:", err.message);
    res.status(500).json({ message: "Could not issue certificates" });
  }
};

const MAX_SHEET_ROWS = 500;
const digits = (v) => String(v || "").replace(/\D/g, "").slice(-10);

// Rows come from an uploaded spreadsheet (parsed in the browser). People in the
// sheet need no account; if an email/phone matches one of this institute's
// students the certificate is also linked to them so it shows in My Certificates.
exports.issueFromSheet = async (req, res) => {
  try {
    const b = req.body || {};
    const template = await findTemplate(req);
    if (!template) return res.status(404).json({ message: "Template not found" });

    const raw = Array.isArray(b.rows) ? b.rows : [];
    if (!raw.length) return res.status(400).json({ message: "The sheet has no rows" });
    if (raw.length > MAX_SHEET_ROWS) return res.status(400).json({ message: `Upload at most ${MAX_SHEET_ROWS} rows at a time` });

    const defaults = b.defaults || {};
    const defDate = defaults.date ? new Date(defaults.date) : new Date();
    if (Number.isNaN(defDate.getTime())) return res.status(400).json({ message: "Enter a valid default date" });
    const defCourse = String(defaults.course || "").trim().slice(0, 120);
    const defGrade = String(defaults.grade || "").trim().slice(0, 40);

    const emails = raw.map((r) => String(r?.email || "").trim().toLowerCase()).filter(Boolean);
    const phones = raw.map((r) => digits(r?.phone)).filter((p) => p.length >= 8);
    const [pool, courses] = await Promise.all([
      emails.length || phones.length
        ? User.find({ admin: req.user._id, role: "student" }).select("name email phone course batch")
        : [],
      Course.find({ admin: req.user._id }).select("name"),
    ]);
    const byEmail = new Map(pool.map((u) => [String(u.email || "").toLowerCase(), u]));
    const byPhone = new Map(pool.filter((u) => digits(u.phone).length >= 8).map((u) => [digits(u.phone), u]));
    const courseById = new Map(courses.map((c) => [String(c._id), c.name]));

    const invalid = [];
    const entries = [];
    const seenNo = new Set();
    raw.forEach((r, i) => {
      const row = Number(r?.row) || i + 2;
      const email = String(r?.email || "").trim().toLowerCase().slice(0, 120);
      const phone = String(r?.phone || "").trim().slice(0, 20);
      const student = (email && byEmail.get(email)) || (digits(phone).length >= 8 && byPhone.get(digits(phone))) || null;
      const name = String(r?.name || "").trim().slice(0, 100) || student?.name || "";
      if (!name) return invalid.push({ row, name: "", reason: "Name is missing" });

      let date = defDate;
      if (r?.date) {
        date = new Date(r.date);
        if (Number.isNaN(date.getTime())) return invalid.push({ row, name, reason: "Date is not valid" });
      }
      const certificateNo = String(r?.certificateNo || "").trim().slice(0, 40);
      if (certificateNo) {
        if (seenNo.has(certificateNo)) return invalid.push({ row, name, reason: "Certificate number repeated in the sheet" });
        seenNo.add(certificateNo);
      }
      entries.push({
        student,
        name,
        email,
        phone,
        course: String(r?.course || "").trim().slice(0, 120) || defCourse || (student?.course ? courseById.get(String(student.course)) || "" : ""),
        batch: String(r?.batch || "").trim().slice(0, 80),
        grade: String(r?.grade || "").trim().slice(0, 40) || defGrade,
        date,
        certificateNo,
        row,
      });
    });

    // Typed-in numbers must not collide with ones already issued.
    const typed = entries.map((e) => e.certificateNo).filter(Boolean);
    const taken = typed.length
      ? new Set((await Certificate.find({ admin: req.user._id, certificateNo: { $in: typed } }).select("certificateNo")).map((c) => c.certificateNo))
      : new Set();
    const ready = entries.filter((e) => {
      if (e.certificateNo && taken.has(e.certificateNo)) {
        invalid.push({ row: e.row, name: e.name, reason: "Certificate number already used" });
        return false;
      }
      return true;
    });
    if (!ready.length) return res.status(400).json({ message: "No valid rows to issue", invalid });

    const options = readIssueOptions(b);
    const out = await issueEntries(req, template, ready, !!b.allowDuplicate, options);
    const emailJob = maybeStartEmails(req, out, options);
    delete out.createdIds;
    res
      .status(out.certificates.length ? 201 : 409)
      .json({ ...out, emailJob, invalid, message: out.certificates.length ? undefined : "Nothing to issue" });
  } catch (err) {
    if (dupNumber(err)) return res.status(409).json({ message: "A certificate number in the sheet already exists" });
    console.error("[certificate] sheet issue failed:", err.message);
    res.status(500).json({ message: "Could not issue certificates" });
  }
};

// ---- register --------------------------------------------------------------

function shapeCert(c, templateName) {
  return {
    _id: c._id,
    certificateNo: c.certificateNo,
    studentId: c.student?._id || c.student || null,
    studentName: c.values.student_name,
    templateId: c.template?._id || c.template,
    templateName: templateName ?? c.template?.name ?? "",
    course: c.values.course,
    grade: c.values.grade,
    date: c.values.date,
    status: c.status,
    revokedReason: c.revokedReason,
    issuedAt: c.createdAt,
    verifyUrl: verifyUrlFor(c.verifyCode),
    qrEnabled: c.qrEnabled !== false,
    batchId: c.batch?._id || c.batch || null,
    batchName: c.batch?.name || "",
    hasEmail: !!c.recipient?.email,
    emailedAt: c.emailStatus?.sentAt || null,
    emailError: c.emailStatus?.error || "",
  };
}

exports.listCertificates = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req, 15, 100);
    const filter = { admin: req.user._id };
    if (req.query.template && mongoose.isValidObjectId(req.query.template)) filter.template = req.query.template;
    if (req.query.status === "active" || req.query.status === "revoked") filter.status = req.query.status;
    if (req.query.batch && mongoose.isValidObjectId(req.query.batch)) filter.batch = req.query.batch;
    if (req.query.student && mongoose.isValidObjectId(req.query.student)) filter.student = req.query.student;
    if (req.query.q) {
      const rx = new RegExp(escapeRegex(String(req.query.q).slice(0, 80)), "i");
      filter.$or = [{ certificateNo: rx }, { "values.student_name": rx }, { "values.course": rx }];
    }
    const [total, rows] = await Promise.all([
      Certificate.countDocuments(filter),
      Certificate.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate("template", "name")
        .populate("batch", "name"),
    ]);
    res.json({
      certificates: rows.map((c) => shapeCert(c)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const ownCertificate = (req) =>
  Certificate.findOne({ _id: req.params.id, admin: req.user._id }).catch(() => null);

exports.revoke = async (req, res) => {
  try {
    const c = await ownCertificate(req);
    if (!c) return res.status(404).json({ message: "Certificate not found" });
    c.status = "revoked";
    c.revokedReason = String(req.body?.reason || "").trim().slice(0, 300);
    c.revokedAt = new Date();
    await c.save();
    res.json({ certificate: shapeCert(c) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.restore = async (req, res) => {
  try {
    const c = await ownCertificate(req);
    if (!c) return res.status(404).json({ message: "Certificate not found" });
    c.status = "active";
    c.revokedReason = "";
    c.revokedAt = null;
    await c.save();
    res.json({ certificate: shapeCert(c) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ---- PDFs ------------------------------------------------------------------

const templatesFor = async (certs) => {
  const templates = await CertificateTemplate.find({ _id: { $in: [...new Set(certs.map((c) => String(c.template)))] } });
  return new Map(templates.map((t) => [String(t._id), t]));
};

const pdfItem = (c, byId) => ({
  template: byId.get(String(c.template)),
  certificateNo: c.certificateNo,
  verifyUrl: verifyUrlFor(c.verifyCode),
  values: c.values,
  showQr: c.qrEnabled !== false,
});

const pdfItems = async (certs) => {
  const byId = await templatesFor(certs);
  return certs.filter((c) => byId.has(String(c.template))).map((c) => pdfItem(c, byId));
};

exports.pdfOne = async (req, res) => {
  try {
    const c = await ownCertificate(req);
    if (!c) return res.status(404).json({ message: "Certificate not found" });
    const items = await pdfItems([c]);
    if (!items.length) return res.status(404).json({ message: "Template no longer available" });
    sendPdf(res, await buildPdf(items), `${safeName(c.certificateNo)}.pdf`);
  } catch (err) {
    console.error("[certificate] pdf failed:", err.message);
    res.status(500).json({ message: "Could not generate the PDF" });
  }
};

// Many certificates merged into one PDF (one page each) for printing.
exports.pdfMany = async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((i) => mongoose.isValidObjectId(i));
    if (!ids.length) return res.status(400).json({ message: "Select at least one certificate" });
    if (ids.length > MAX_PDF_BATCH) return res.status(400).json({ message: `Download at most ${MAX_PDF_BATCH} at a time` });
    const certs = await Certificate.find({ _id: { $in: ids }, admin: req.user._id }).sort({ certificateNo: 1 });
    if (!certs.length) return res.status(404).json({ message: "Certificates not found" });
    const items = await pdfItems(certs);
    sendPdf(res, await buildPdf(items), "certificates.pdf");
  } catch (err) {
    console.error("[certificate] bulk pdf failed:", err.message);
    res.status(500).json({ message: "Could not generate the PDF" });
  }
};

// ---- student ---------------------------------------------------------------

exports.myCertificates = async (req, res) => {
  try {
    const rows = await Certificate.find({ student: req.user._id, status: "active" })
      .sort({ createdAt: -1 })
      .populate("template", "name");
    res.json({ certificates: rows.map((c) => shapeCert(c)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.myCertificatePdf = async (req, res) => {
  try {
    const c = await Certificate.findOne({ _id: req.params.id, student: req.user._id, status: "active" }).catch(() => null);
    if (!c) return res.status(404).json({ message: "Certificate not found" });
    const items = await pdfItems([c]);
    if (!items.length) return res.status(404).json({ message: "Certificate unavailable" });
    sendPdf(res, await buildPdf(items), `${safeName(c.certificateNo)}.pdf`);
  } catch (err) {
    console.error("[certificate] student pdf failed:", err.message);
    res.status(500).json({ message: "Could not generate the PDF" });
  }
};

// ---- public verification ---------------------------------------------------

exports.verify = async (req, res) => {
  try {
    const code = String(req.params.code || "").toLowerCase();
    if (!/^[a-f0-9]{12}$/.test(code)) return res.status(404).json({ message: "Certificate not found" });
    const c = await Certificate.findOne({ verifyCode: code });
    if (!c) return res.status(404).json({ message: "Certificate not found" });
    const admin = await User.findById(c.admin).select("name instituteSlug logo brandColor");
    res.json({
      status: c.status,
      certificateNo: c.certificateNo,
      studentName: c.values.student_name,
      course: c.values.course,
      grade: c.values.grade,
      date: c.values.date,
      revokedReason: c.status === "revoked" ? c.revokedReason : "",
      institute: shapeInstitute(admin) || { name: admin?.name || "", slug: "", logoUrl: null },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Anyone with the link (the QR page) can download the PDF of a genuine certificate.
exports.verifyPdf = async (req, res) => {
  try {
    const code = String(req.params.code || "").toLowerCase();
    if (!/^[a-f0-9]{12}$/.test(code)) return res.status(404).json({ message: "Certificate not found" });
    const c = await Certificate.findOne({ verifyCode: code });
    if (!c) return res.status(404).json({ message: "Certificate not found" });
    if (c.status !== "active") return res.status(403).json({ message: "This certificate has been revoked" });
    const items = await pdfItems([c]);
    if (!items.length) return res.status(404).json({ message: "Certificate unavailable" });
    sendPdf(res, await buildPdf(items), `${safeName(c.certificateNo)}.pdf`);
  } catch (err) {
    console.error("[certificate] public pdf failed:", err.message);
    res.status(500).json({ message: "Could not generate the PDF" });
  }
};

// ---- certificate batches ---------------------------------------------------

exports.listBatches = async (req, res) => {
  try {
    const [batches, counts] = await Promise.all([
      CertificateBatch.find({ admin: req.user._id }).sort({ createdAt: -1 }).limit(100).populate("template", "name"),
      Certificate.aggregate([
        { $match: { admin: req.user._id, batch: { $ne: null } } },
        {
          $group: {
            _id: "$batch",
            total: { $sum: 1 },
            withEmail: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$recipient.email", ""] } }, 0] }, 1, 0] } },
            emailed: { $sum: { $cond: [{ $gt: ["$emailStatus.sentAt", null] }, 1, 0] } },
          },
        },
      ]),
    ]);
    const byId = new Map(counts.map((r) => [String(r._id), r]));
    res.json({
      batches: batches.map((b) => {
        const n = byId.get(String(b._id)) || { total: 0, withEmail: 0, emailed: 0 };
        return {
          _id: b._id,
          name: b.name,
          templateName: b.template?.name || "",
          createdAt: b.createdAt,
          total: n.total,
          withEmail: n.withEmail,
          emailed: n.emailed,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ---- QR code on / off ------------------------------------------------------

// Leaves the QR code off (or puts it back on) the PDF of the chosen certificates.
exports.setQr = async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((i) => mongoose.isValidObjectId(i));
    if (!ids.length) return res.status(400).json({ message: "Select at least one certificate" });
    const enabled = req.body?.enabled !== false;
    const r = await Certificate.updateMany({ _id: { $in: ids }, admin: req.user._id }, { $set: { qrEnabled: enabled } });
    res.json({ updated: r.modifiedCount ?? r.nModified ?? 0, qrEnabled: enabled });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ---- emailing certificates -------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_JOB = 500;

// Progress of running / recent email jobs, kept in memory. Which certificate was
// emailed lives on the certificate itself, so a restart only loses the progress
// bar; "email the ones not sent yet" then picks up where it stopped.
const emailJobs = new Map();
const activeJobByAdmin = new Map();

// Emails one certificate's PDF. Returns { status, error? } where status is one of
// sent | failed | limited | noEmail | revoked | setup.
const deliverCertificate = async (admin, cert, template, { resend }) => {
  if (cert.status !== "active") return { status: "revoked" };
  const to = String(cert.recipient?.email || "").trim();
  if (!to) return { status: "noEmail" };
  if (!EMAIL_PATTERN.test(to)) {
    await Certificate.updateOne({ _id: cert._id }, { $set: { "emailStatus.error": "The email address is not valid" } });
    return { status: "failed", error: "The email address is not valid" };
  }
  if (!resend && cert.emailStatus?.sentAt) return { status: "alreadySent" };
  if (!template) return { status: "failed", error: "The certificate template is no longer available" };

  let pdf;
  try {
    pdf = await buildPdf([pdfItem(cert, new Map([[String(template._id), template]]))]);
  } catch (err) {
    console.error("[certificate] email pdf failed:", err.message);
    return { status: "failed", error: "Could not create the PDF" };
  }
  const result = await sendCertificateEmail(admin._id, {
    to,
    name: cert.values.student_name,
    instituteName: admin.name,
    course: cert.values.course,
    certificateNo: cert.certificateNo,
    verifyUrl: verifyUrlFor(cert.verifyCode),
    pdf,
    filename: `${safeName(cert.certificateNo)}.pdf`,
  });
  if (result.sent) {
    await Certificate.updateOne(
      { _id: cert._id },
      { $set: { "emailStatus.sentAt": new Date(), "emailStatus.to": to, "emailStatus.error": "" } }
    );
    return { status: "sent" };
  }
  if (result.limited) return { status: "limited" };
  if (result.setup) return { status: "setup", error: result.reason };
  await Certificate.updateOne({ _id: cert._id }, { $set: { "emailStatus.error": String(result.reason || "Could not send").slice(0, 200) } });
  return { status: "failed", error: result.reason };
};

const runEmailJob = async (admin, ids, resend, job) => {
  const certs = await Certificate.find({ _id: { $in: ids }, admin: admin._id }).sort({ certificateNo: 1 });
  const templates = await templatesFor(certs);
  job.total = certs.length;
  for (let i = 0; i < certs.length; i += 1) {
    const r = await deliverCertificate(admin, certs[i], templates.get(String(certs[i].template)), { resend });
    if (r.status === "limited") {
      // The day's cap is reached: everything still waiting goes out on a later run.
      job.limited = certs.slice(i).filter((c) => c.status === "active" && c.recipient?.email && (resend || !c.emailStatus?.sentAt)).length;
      break;
    }
    if (r.status === "setup") {
      job.error = r.error;
      job.notSent = certs.length - i;
      break;
    }
    if (r.status === "sent") job.sent += 1;
    else if (r.status === "failed") job.failed += 1;
    else if (r.status === "noEmail") job.noEmail += 1;
    else if (r.status === "alreadySent") job.alreadySent += 1;
    else if (r.status === "revoked") job.revoked += 1;
    job.done = i + 1;
  }
};

const startEmailJob = (admin, ids, { resend }) => {
  const key = String(admin._id);
  const running = activeJobByAdmin.get(key);
  if (running && emailJobs.get(running)?.state === "running") {
    return { error: "Certificates are already being emailed. Wait for that to finish.", jobId: running };
  }
  const jobId = crypto.randomBytes(8).toString("hex");
  const job = {
    id: jobId,
    admin: key,
    state: "running",
    total: ids.length,
    done: 0,
    sent: 0,
    failed: 0,
    noEmail: 0,
    alreadySent: 0,
    revoked: 0,
    limited: 0,
    notSent: 0,
    error: "",
  };
  emailJobs.set(jobId, job);
  activeJobByAdmin.set(key, jobId);
  runEmailJob(admin, ids, resend, job)
    .catch((err) => {
      console.error("[certificate] email job failed:", err.message);
      job.error = "Something went wrong while sending. Try again.";
    })
    .finally(() => {
      job.state = "done";
      setTimeout(() => emailJobs.delete(jobId), 30 * 60 * 1000).unref?.();
    });
  return { jobId };
};

// Email many: the ids given, or every certificate in a batch. By default skips
// the ones already emailed; resend = true sends them again.
exports.emailCertificates = async (req, res) => {
  try {
    const b = req.body || {};
    let ids;
    if (b.batchId) {
      if (!mongoose.isValidObjectId(b.batchId)) return res.status(404).json({ message: "Batch not found" });
      const batch = await CertificateBatch.findOne({ _id: b.batchId, admin: req.user._id });
      if (!batch) return res.status(404).json({ message: "Batch not found" });
      ids = (await Certificate.find({ batch: batch._id, admin: req.user._id }).select("_id")).map((c) => c._id);
    } else {
      ids = (Array.isArray(b.ids) ? b.ids : []).filter((i) => mongoose.isValidObjectId(i));
    }
    if (!ids.length) return res.status(400).json({ message: "Select at least one certificate" });
    if (ids.length > MAX_EMAIL_JOB) return res.status(400).json({ message: `Email at most ${MAX_EMAIL_JOB} certificates at a time` });

    const started = startEmailJob(req.user, ids, { resend: !!b.resend });
    if (started.error) return res.status(409).json({ message: started.error, jobId: started.jobId });
    res.status(202).json({ jobId: started.jobId, total: ids.length });
  } catch (err) {
    console.error("[certificate] email start failed:", err.message);
    res.status(500).json({ message: "Could not start emailing" });
  }
};

exports.emailJobStatus = (req, res) => {
  const job = emailJobs.get(String(req.params.id));
  if (!job || job.admin !== String(req.user._id)) return res.status(404).json({ message: "Job not found" });
  const { admin, ...rest } = job;
  res.json({ job: rest });
};

// Email one certificate right now (also used to send it again).
exports.emailOne = async (req, res) => {
  try {
    const c = await ownCertificate(req);
    if (!c) return res.status(404).json({ message: "Certificate not found" });
    const template = await CertificateTemplate.findById(c.template);
    const r = await deliverCertificate(req.user, c, template, { resend: true });
    const fresh = await Certificate.findById(c._id).populate("template", "name").populate("batch", "name");
    switch (r.status) {
      case "sent":
        return res.json({ certificate: shapeCert(fresh) });
      case "noEmail":
        return res.status(400).json({ message: "This person has no email address" });
      case "revoked":
        return res.status(400).json({ message: "A revoked certificate can't be emailed" });
      case "limited":
        return res.status(429).json({ message: "Today's email limit is reached. Try again tomorrow." });
      case "setup":
        return res.status(400).json({ message: r.error || "Set up your sender email in Settings first." });
      default:
        return res.status(502).json({ message: r.error || "Could not send the email" });
    }
  } catch (err) {
    console.error("[certificate] email one failed:", err.message);
    res.status(500).json({ message: "Could not send the email" });
  }
};
