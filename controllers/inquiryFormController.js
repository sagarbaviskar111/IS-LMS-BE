const crypto = require("crypto");
const InquiryForm = require("../models/InquiryForm");
const InquiryResponse = require("../models/InquiryResponse");
const User = require("../models/User");
const Lead = require("../models/Lead");
const { assignTelecaller } = require("./leadController");
const { normalizePhone, normalizeEmail, normalizeName, normalizeNamePart } = require("../utils/validators");
const paginate = require("../utils/paginate");
const { dateRange } = require("../utils/dateRange");
const { slugify } = require("../utils/slug");
const { shapeInstitute } = require("../utils/institute");
const { QUESTION_TYPES } = InquiryForm;

const CHOICE_TYPES = ["multiple_choice", "checkboxes", "dropdown"];
const GRID_TYPES = ["multiple_choice_grid", "checkbox_grid"];
const TEXT_TYPES = ["short_text", "paragraph", "name", "phone", "email"];
const LEAD_DEFAULT_TITLE = "Would you like us to contact you about joining?";
const TEXT_MAX = 5000;
const SUMMARY_CAP = 10000;
const ID_RE = /^[A-Za-z0-9_]{1,40}$/;

const newPublicId = async () => {
  for (let i = 0; i < 5; i++) {
    const id = crypto.randomBytes(5).toString("hex").slice(0, 8);
    if (!(await InquiryForm.exists({ publicId: id }))) return id;
  }
  return crypto.randomBytes(8).toString("hex");
};

const cleanList = (arr) => {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
};

// Validates + normalises the question list from the builder. Returns
// { questions } or { error }.
const sanitizeQuestions = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Add at least one question" };
  if (raw.length > 100) return { error: "A form can have at most 100 questions" };

  const ids = new Set();
  const questions = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") return { error: "Invalid question" };
    if (!ID_RE.test(q.id || "") || ids.has(q.id)) return { error: "Invalid question id" };
    ids.add(q.id);
    if (!QUESTION_TYPES.includes(q.type)) return { error: "Invalid question type" };
    const title = (q.title || "").toString().trim() || (q.type === "lead" ? LEAD_DEFAULT_TITLE : "");
    if (!title) return { error: "Every question needs a title" };

    const out = {
      id: q.id,
      type: q.type,
      title,
      description: (q.description || "").toString().trim(),
      // A lead question is always required - an unanswered one can't route anyone.
      required: q.type === "lead" ? true : !!q.required,
    };

    if (CHOICE_TYPES.includes(q.type)) {
      out.options = cleanList(q.options);
      if (out.options.length < 1) return { error: `"${title}" needs at least one option` };
    } else if (q.type === "linear_scale") {
      const min = Number(q.scaleMin);
      const max = Number(q.scaleMax);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min > 1 || max < 2 || max > 10) {
        return { error: `"${title}": scale must start at 0 or 1 and end between 2 and 10` };
      }
      out.scaleMin = min;
      out.scaleMax = max;
      out.scaleMinLabel = (q.scaleMinLabel || "").toString().trim();
      out.scaleMaxLabel = (q.scaleMaxLabel || "").toString().trim();
    } else if (GRID_TYPES.includes(q.type)) {
      out.rows = cleanList(q.rows);
      out.columns = cleanList(q.columns);
      if (out.rows.length < 1 || out.columns.length < 1) {
        return { error: `"${title}" needs at least one row and one column` };
      }
    }
    questions.push(out);
  }

  const leadQs = questions.filter((q) => q.type === "lead");
  if (leadQs.length > 1) return { error: "A form can have only one Lead question" };
  if (leadQs.length === 1) {
    const nameQ = questions.find((q) => q.type === "name");
    const phoneQ = questions.find((q) => q.type === "phone");
    if (!nameQ || !phoneQ || !nameQ.required || !phoneQ.required) {
      return {
        error:
          "A Lead question needs a required Name (first + last) question and a required Phone number question on the same form, so the lead has someone to call",
      };
    }
  }
  return { questions };
};

const parseFormKey = (formKey) => {
  const i = (formKey || "").lastIndexOf("-");
  return i === -1 ? formKey : formKey.slice(i + 1);
};

// Callers (telecallers) read their institute's forms; everything below is
// scoped to the institute (admin) the signed-in user belongs to.
const ownerId = (req) => (req.user.role === "admin" ? req.user._id : req.user.admin);
const getOwner = async (req) =>
  req.user.role === "admin" ? req.user : User.findById(req.user.admin).select("name instituteSlug");

const formPath = (admin, form) =>
  `/${admin.instituteSlug}/inquiry/${slugify(form.subject) || "form"}-${form.publicId}`;

// ---------------- Admin: forms ----------------

exports.createForm = async (req, res) => {
  try {
    const subject = (req.body.subject || "").toString().trim();
    if (!subject) return res.status(400).json({ message: "Subject line is required" });
    const { questions, error } = sanitizeQuestions(req.body.questions);
    if (error) return res.status(400).json({ message: error });
    if (!req.user.instituteSlug) {
      return res.status(400).json({ message: "Set up your institute branding (URL slug) first" });
    }

    const form = await InquiryForm.create({
      admin: req.user._id,
      publicId: await newPublicId(),
      subject,
      description: (req.body.description || "").toString().trim(),
      questions,
    });
    res.status(201).json({ form, path: formPath(req.user, form) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listForms = async (req, res) => {
  try {
    const owner = await getOwner(req);
    if (!owner) return res.status(403).json({ message: "Not linked to an institute" });
    const forms = await InquiryForm.find({ admin: owner._id }).select("-questions").sort({ createdAt: -1 });
    res.json({
      forms: forms.map((f) => ({ ...f.toObject(), path: formPath(owner, f) })),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const findOwnForm = (req) => InquiryForm.findOne({ _id: req.params.id, admin: ownerId(req) });

exports.getForm = async (req, res) => {
  try {
    const form = await findOwnForm(req);
    if (!form) return res.status(404).json({ message: "Form not found" });
    res.json({ form, path: formPath(await getOwner(req), form) });
  } catch (err) {
    res.status(404).json({ message: "Form not found" });
  }
};

exports.updateForm = async (req, res) => {
  try {
    const form = await findOwnForm(req);
    if (!form) return res.status(404).json({ message: "Form not found" });

    if (req.body.subject !== undefined) {
      const subject = req.body.subject.toString().trim();
      if (!subject) return res.status(400).json({ message: "Subject line is required" });
      form.subject = subject;
    }
    if (req.body.description !== undefined) form.description = req.body.description.toString().trim();
    if (req.body.isActive !== undefined) form.isActive = !!req.body.isActive;
    if (req.body.questions !== undefined) {
      const { questions, error } = sanitizeQuestions(req.body.questions);
      if (error) return res.status(400).json({ message: error });
      form.questions = questions;
    }
    await form.save();
    res.json({ form, path: formPath(req.user, form) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteForm = async (req, res) => {
  try {
    const form = await findOwnForm(req);
    if (!form) return res.status(404).json({ message: "Form not found" });
    await InquiryResponse.deleteMany({ form: form._id });
    await form.deleteOne();
    res.json({ message: "Form deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------- Admin: responses ----------------

// Builds the Mongo query from ?from, ?to and ?filters=[{questionId,value,valueTo}].
const buildResponseQuery = (form, req) => {
  const query = { form: form._id };

  const range = dateRange(req.query);
  if (range) query.createdAt = range;

  // ?inLead=yes|no - whether the response has become a lead yet.
  if (req.query.inLead === "yes") query.lead = { $ne: null };
  else if (req.query.inLead === "no") query.lead = null;

  let filters = [];
  try {
    filters = req.query.filters ? JSON.parse(req.query.filters) : [];
  } catch {
    filters = [];
  }
  if (!Array.isArray(filters)) filters = [];

  for (const f of filters.slice(0, 20)) {
    const q = form.questions.find((x) => x.id === f?.questionId);
    const value = f?.value === undefined || f?.value === null ? "" : String(f.value).trim();
    if (!q || value === "") continue;
    const key = `answers.${q.id}`;

    if (TEXT_TYPES.includes(q.type)) {
      query[key] = { $regex: value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    } else if (q.type === "linear_scale") {
      const n = Number(value);
      if (Number.isFinite(n)) query[key] = n;
    } else if (q.type === "date" || q.type === "time") {
      const bounds = { $gte: value };
      if (f.valueTo) bounds.$lte = String(f.valueTo);
      query[key] = bounds;
    } else if (CHOICE_TYPES.includes(q.type) || q.type === "lead") {
      // Equality on an array field matches if the array contains the value.
      query[key] = value;
    }
  }
  return query;
};

exports.listResponses = async (req, res) => {
  try {
    const form = await findOwnForm(req);
    if (!form) return res.status(404).json({ message: "Form not found" });

    const query = buildResponseQuery(form, req);
    const { page, limit, skip } = paginate(req, 20, 200);
    const [responses, total, matching] = await Promise.all([
      InquiryResponse.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      InquiryResponse.countDocuments(query),
      InquiryResponse.find(query).select("answers").limit(SUMMARY_CAP).lean(),
    ]);

    // Per-question summary over everything matching the filters (not just this page).
    const summary = {};
    for (const q of form.questions) {
      const answered = matching.filter((r) => r.answers?.[q.id] !== undefined && r.answers[q.id] !== "");
      const s = { answered: answered.length };
      if (CHOICE_TYPES.includes(q.type)) {
        s.counts = Object.fromEntries(q.options.map((o) => [o, 0]));
        for (const r of answered) {
          for (const v of [].concat(r.answers[q.id])) if (v in s.counts) s.counts[v] += 1;
        }
      } else if (q.type === "lead") {
        s.counts = { yes: 0, no: 0 };
        for (const r of answered) if (r.answers[q.id] in s.counts) s.counts[r.answers[q.id]] += 1;
      } else if (q.type === "linear_scale") {
        s.counts = {};
        for (let i = q.scaleMin; i <= q.scaleMax; i++) s.counts[i] = 0;
        let sum = 0;
        for (const r of answered) {
          const v = Number(r.answers[q.id]);
          if (v in s.counts) {
            s.counts[v] += 1;
            sum += v;
          }
        }
        s.average = answered.length ? Math.round((sum / answered.length) * 100) / 100 : null;
      }
      summary[q.id] = s;
    }

    res.json({
      responses,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      summary,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const formatAnswer = (q, v) => {
  if (v === undefined || v === null) return "";
  if (GRID_TYPES.includes(q.type)) {
    return Object.entries(v)
      .map(([row, val]) => `${row}: ${[].concat(val).join(" | ")}`)
      .join("; ");
  }
  return Array.isArray(v) ? v.join(", ") : String(v);
};

const csvCell = (v) => {
  let s = String(v ?? "");
  // Neutralise spreadsheet formula injection from respondent-supplied text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

exports.exportResponses = async (req, res) => {
  try {
    const form = await findOwnForm(req);
    if (!form) return res.status(404).json({ message: "Form not found" });

    const responses = await InquiryResponse.find(buildResponseQuery(form, req))
      .sort({ createdAt: -1 })
      .limit(SUMMARY_CAP)
      .lean();

    const header = ["Submitted at", ...form.questions.map((q) => q.title)];
    const lines = [header.map(csvCell).join(",")];
    for (const r of responses) {
      lines.push(
        [r.createdAt.toISOString(), ...form.questions.map((q) => formatAnswer(q, r.answers?.[q.id]))]
          .map(csvCell)
          .join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.send("﻿" + lines.join("\r\n"));
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteResponse = async (req, res) => {
  try {
    const form = await findOwnForm(req);
    if (!form) return res.status(404).json({ message: "Form not found" });
    const r = await InquiryResponse.findOneAndDelete({ _id: req.params.responseId, form: form._id });
    if (!r) return res.status(404).json({ message: "Response not found" });
    await InquiryForm.updateOne({ _id: form._id }, { $inc: { responseCount: -1 } });
    res.json({ message: "Response deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------- Leads from responses ----------------

// Turns a response into a Lead (or links it to the existing lead with the same
// phone). actor = the admin/telecaller adding it by hand, or null for the
// automatic "yes" path (round-robin assignment).
const createLeadFromResponse = async (form, response, actor) => {
  const nameQ = form.questions.find((q) => q.type === "name");
  const phoneQ = form.questions.find((q) => q.type === "phone");
  const emailQ = form.questions.find((q) => q.type === "email");
  const name = nameQ && response.answers?.[nameQ.id];
  const phone = phoneQ && response.answers?.[phoneQ.id];
  if (!name || !phone) {
    return { error: "This form has no answered Name and Phone number, so a lead can't be created from it" };
  }
  const email = emailQ ? response.answers?.[emailQ.id] : undefined;

  let lead = await Lead.findOne({ admin: form.admin, phone });
  const existed = !!lead;
  if (!lead) {
    // Same even split as every other lead source — whoever adds it (admin or a
    // telecaller), it goes to the telecaller with the fewest leads. Only the
    // admin reassigns by hand afterwards.
    const assignedTelecaller = await assignTelecaller(form.admin);
    lead = await Lead.create({
      admin: form.admin,
      createdBy: actor ? actor._id : form.admin,
      name,
      phone,
      email,
      notes: `From inquiry form: ${form.subject}`,
      assignedTelecaller,
      source: "inquiry_form",
      sourceLabel: form.subject.slice(0, 60),
    });
  }

  await InquiryResponse.updateOne(
    { _id: response._id },
    { lead: lead._id, leadAddedBy: actor ? actor._id : null, leadAddedAt: new Date() }
  );
  return { lead, existed };
};

exports.addResponseToLead = async (req, res) => {
  try {
    const form = await findOwnForm(req);
    if (!form) return res.status(404).json({ message: "Form not found" });
    const response = await InquiryResponse.findOne({ _id: req.params.responseId, form: form._id });
    if (!response) return res.status(404).json({ message: "Response not found" });
    if (response.lead) return res.status(409).json({ message: "This response is already in your leads" });

    const result = await createLeadFromResponse(form, response, req.user);
    if (result.error) return res.status(400).json({ message: result.error });
    res.status(201).json({
      message: result.existed ? "A lead with this phone number already existed - linked to it" : "Added to leads",
      leadId: result.lead._id,
      existed: result.existed,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// ---------------- Public ----------------

const loadPublicForm = async (slug, formKey) => {
  const admin = await User.findOne({
    instituteSlug: (slug || "").toLowerCase(),
    role: "admin",
    isActive: true,
  }).select("name instituteSlug logo brandColor brandColorPrimary brandColorBackground");
  if (!admin) return {};
  const form = await InquiryForm.findOne({ admin: admin._id, publicId: parseFormKey(formKey) });
  return { admin, form };
};

exports.getPublicForm = async (req, res) => {
  try {
    const { admin, form } = await loadPublicForm(req.params.slug, req.params.formKey);
    if (!form) return res.status(404).json({ message: "Form not found" });
    res.json({
      institute: shapeInstitute(admin),
      form: {
        subject: form.subject,
        description: form.description,
        isActive: form.isActive,
        questions: form.isActive ? form.questions : [],
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const isEmpty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

// Returns { value } (normalised), {} for a skipped optional answer, or { error }.
const validateAnswer = (q, v) => {
  // The name question is sent as { first, last }; both blank counts as unanswered.
  if (q.type === "name" && v && typeof v === "object" && !Array.isArray(v)) {
    if (!String(v.first ?? "").trim() && !String(v.last ?? "").trim()) v = "";
  }
  if (isEmpty(v)) {
    return q.required ? { error: `"${q.title}" is required` } : {};
  }
  const bad = { error: `Invalid answer for "${q.title}"` };

  switch (q.type) {
    case "short_text":
    case "paragraph":
      return typeof v === "string" && v.length <= TEXT_MAX ? { value: v.trim() } : bad;
    case "name": {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const first = normalizeNamePart(v.first);
        const last = normalizeNamePart(v.last);
        if (!first) return { error: `"${q.title}": enter a valid first name (letters only)` };
        if (!last) return { error: `"${q.title}": enter a valid last name (letters only)` };
        // Stored as one string so leads, filters and CSV keep working unchanged.
        return { value: `${first} ${last}` };
      }
      const n = typeof v === "string" ? normalizeName(v) : null;
      return n ? { value: n } : { error: `"${q.title}": enter a valid name (letters only, at least 2 characters)` };
    }
    case "phone": {
      const p = typeof v === "string" ? normalizePhone(v) : null;
      return p
        ? { value: p }
        : { error: `"${q.title}": enter a valid 10-digit mobile number, or a full number with country code (+...)` };
    }
    case "email": {
      const e = typeof v === "string" ? normalizeEmail(v) : null;
      return e ? { value: e } : { error: `"${q.title}": enter a valid email address like name@example.com` };
    }
    case "lead":
      return v === "yes" || v === "no" ? { value: v } : bad;
    case "multiple_choice":
    case "dropdown":
      return typeof v === "string" && q.options.includes(v) ? { value: v } : bad;
    case "checkboxes":
      return Array.isArray(v) && v.every((x) => q.options.includes(x)) ? { value: [...new Set(v)] } : bad;
    case "linear_scale": {
      const n = Number(v);
      return Number.isInteger(n) && n >= q.scaleMin && n <= q.scaleMax ? { value: n } : bad;
    }
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? { value: v } : bad;
    case "time":
      return typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? { value: v } : bad;
    case "multiple_choice_grid":
    case "checkbox_grid": {
      if (typeof v !== "object" || Array.isArray(v)) return bad;
      const out = {};
      for (const row of q.rows) {
        const cell = v[row];
        if (isEmpty(cell)) {
          if (q.required) return { error: `"${q.title}": answer every row` };
          continue;
        }
        if (q.type === "multiple_choice_grid") {
          if (typeof cell !== "string" || !q.columns.includes(cell)) return bad;
          out[row] = cell;
        } else {
          if (!Array.isArray(cell) || !cell.every((x) => q.columns.includes(x))) return bad;
          out[row] = [...new Set(cell)];
        }
      }
      return Object.keys(out).length ? { value: out } : {};
    }
    default:
      return bad;
  }
};

exports.submitPublicForm = async (req, res) => {
  try {
    const { admin, form } = await loadPublicForm(req.params.slug, req.params.formKey);
    if (!form) return res.status(404).json({ message: "Form not found" });
    if (!form.isActive) return res.status(403).json({ message: "This form is no longer accepting responses" });

    const submitted = req.body.answers && typeof req.body.answers === "object" ? req.body.answers : {};
    const answers = {};
    for (const q of form.questions) {
      const { value, error } = validateAnswer(q, submitted[q.id]);
      if (error) return res.status(400).json({ message: error });
      if (value !== undefined) answers[q.id] = value;
    }

    const response = await InquiryResponse.create({ form: form._id, admin: admin._id, answers });
    await InquiryForm.updateOne({ _id: form._id }, { $inc: { responseCount: 1 } });

    // "Yes" on the lead question drops them straight into the lead list. A
    // failure here must not lose the submission itself - the admin can still
    // add them by hand from the response.
    const leadQ = form.questions.find((q) => q.type === "lead");
    if (leadQ && answers[leadQ.id] === "yes") {
      try {
        await createLeadFromResponse(form, response, null);
      } catch (err) {
        console.error("[inquiry-form] auto-lead failed:", err.message);
      }
    }
    res.status(201).json({ message: "Response submitted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
