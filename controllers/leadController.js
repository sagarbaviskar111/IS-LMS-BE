const crypto = require("crypto");
const Lead = require("../models/Lead");
const User = require("../models/User");
const Payment = require("../models/Payment");
const paginate = require("../utils/paginate");
const {
  buildLeadFilter,
  buildLeadSort,
  leadSources,
  invalidLeadIds,
  applyInvalidFilter,
  deleteInvalidLeads,
} = require("../utils/leadFilters");
const { normalizePhone, normalizeEmail } = require("../utils/validators");
const { DAY_MS } = require("../utils/paymentCycle");

// Round-robin: whichever active telecaller currently has the fewest leads gets the next one,
// so leads are distributed evenly one-by-one rather than clustering.
const assignTelecaller = async (adminId) => {
  const telecallers = await User.find({ admin: adminId, role: "telecaller", isActive: true }).select("_id");
  if (telecallers.length === 0) return null;

  const counts = await Lead.aggregate([
    { $match: { admin: adminId, assignedTelecaller: { $ne: null } } },
    { $group: { _id: "$assignedTelecaller", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  let chosen = telecallers[0];
  let minCount = Infinity;
  for (const t of telecallers) {
    const c = countMap.get(String(t._id)) || 0;
    if (c < minCount) {
      minCount = c;
      chosen = t;
    }
  }
  return chosen._id;
};

exports.assignTelecaller = assignTelecaller;

exports.createLead = async (req, res) => {
  try {
    const { name, phone, email, notes } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ message: "name and phone are required" });
    }

    const assignedTelecaller = await assignTelecaller(req.user._id);
    if (!assignedTelecaller) {
      return res.status(400).json({ message: "No active telecallers available to assign this lead to" });
    }

    const lead = await Lead.create({
      admin: req.user._id,
      name,
      phone,
      email,
      notes,
      assignedTelecaller,
      createdBy: req.user._id,
    });

    const populated = await lead.populate("assignedTelecaller", "name email");
    res.status(201).json({ lead: populated });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Public — no session, authenticated purely by the per-admin key in the
// URL. Used by external sources (a Google Sheet via a pasted Apps Script
// trigger, another website's backend, Zapier, etc.) to push leads straight
// in. Unlike the manual createLead above, a missing telecaller doesn't
// reject the request — dropping data from an unattended integration would
// be worse than leaving a lead unassigned for the admin to sort out later.
exports.ingestWebhookLead = async (req, res) => {
  try {
    const admin = await User.findOne({ role: "admin", leadWebhookKey: req.params.apiKey });
    if (!admin) {
      return res.status(401).json({ message: "Invalid webhook key" });
    }

    const { name, phone, email, notes, source } = req.body || {};
    const cleanName = String(name ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (cleanName.length < 2 || !String(phone ?? "").trim()) {
      return res.status(400).json({ message: "name and phone are required" });
    }
    // Same phone rules as everywhere else (so "+91 98765-43210", 9876543210
    // and 919876543210 are all the same lead). The message is shown to whoever
    // set the integration up (e.g. in the Google Sheet's "Lead Sync" column).
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) {
      return res.status(400).json({ message: `Invalid phone number "${String(phone).slice(0, 30)}"` });
    }
    // A malformed email shouldn't throw away an otherwise good lead.
    const cleanEmail = String(email ?? "").trim() ? normalizeEmail(email) || undefined : undefined;
    const cleanNotes = String(notes ?? "").trim().slice(0, 1000) || undefined;

    // Re-sent on every edit (a Google Sheet trigger fires on any change to
    // the sheet, not just new rows) — match on phone within this admin's
    // leads and update in place instead of piling up duplicates.
    const existing = await Lead.findOne({ admin: admin._id, phone: cleanPhone });
    if (existing) {
      existing.name = cleanName;
      // A blank cell in the sheet must not wipe what's already saved.
      if (cleanEmail) existing.email = cleanEmail;
      if (cleanNotes) existing.notes = cleanNotes;
      await existing.save();
      return res.json({ message: "Lead updated", lead: existing });
    }

    const assignedTelecaller = await assignTelecaller(admin._id);
    const lead = await Lead.create({
      admin: admin._id,
      createdBy: admin._id,
      name: cleanName,
      phone: cleanPhone,
      email: cleanEmail,
      notes: cleanNotes,
      assignedTelecaller,
      source: "webhook",
      sourceLabel: source ? String(source).trim().slice(0, 60) : "External",
    });
    res.status(201).json({ message: "Lead created", lead });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const MAX_BULK_LEADS = 500;

// POST /api/leads/bulk — rows parsed from an Excel/CSV file in the browser.
// Each row is checked on its own: a bad row is skipped with a reason and
// never blocks the good ones.
exports.bulkCreateLeads = async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "rows must be a non-empty array" });
    }
    if (rows.length > MAX_BULK_LEADS) {
      return res.status(400).json({ message: `Upload at most ${MAX_BULK_LEADS} rows at a time` });
    }
    const fileName = String(req.body.fileName || "")
      .trim()
      .slice(0, 60);

    const telecallers = await User.find({ admin: req.user._id, role: "telecaller", isActive: true }).select("_id email");
    const telecallerByEmail = new Map(telecallers.map((t) => [t.email.toLowerCase(), t._id]));

    const created = [];
    const skipped = [];
    const seen = new Set();

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] || {};
      const row = i + 2; // spreadsheet row number: 1 is the header
      const name = String(raw.name ?? "")
        .trim()
        .replace(/\s+/g, " ");
      const rawPhone = String(raw.phone ?? "").trim();
      const skip = (reason) => skipped.push({ row, name, phone: rawPhone, reason });

      if (name.length < 2 || name.length > 100) {
        skip("Name is required (2–100 characters)");
        continue;
      }
      if (!rawPhone) {
        skip("Phone is required");
        continue;
      }
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        skip("Invalid phone number");
        continue;
      }
      let email;
      if (String(raw.email ?? "").trim()) {
        email = normalizeEmail(raw.email);
        if (!email) {
          skip("Invalid email address");
          continue;
        }
      }
      if (seen.has(phone)) {
        skip("Duplicate phone number in this file");
        continue;
      }
      if (await Lead.exists({ admin: req.user._id, phone })) {
        seen.add(phone);
        skip("Already in your leads");
        continue;
      }

      let assignedTelecaller;
      const callerEmail = String(raw.telecaller ?? "")
        .trim()
        .toLowerCase();
      if (callerEmail) {
        assignedTelecaller = telecallerByEmail.get(callerEmail);
        if (!assignedTelecaller) {
          skip(`No active telecaller with email "${callerEmail}"`);
          continue;
        }
      } else {
        assignedTelecaller = await assignTelecaller(req.user._id);
      }

      await Lead.create({
        admin: req.user._id,
        createdBy: req.user._id,
        name,
        phone,
        email,
        notes: String(raw.notes ?? "")
          .trim()
          .slice(0, 1000),
        assignedTelecaller,
        source: "import",
        sourceLabel: fileName || "Excel/CSV upload",
      });
      seen.add(phone);
      created.push({ row, name, phone, assigned: !!assignedTelecaller });
    }

    res.status(201).json({ created, skipped, noTelecallers: telecallers.length === 0 });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.leadSourceOptions = async (req, res) => {
  try {
    res.json({ sources: await leadSources({ admin: req.user._id }) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listLeads = async (req, res) => {
  try {
    const scope = { admin: req.user._id };
    const filter = await applyInvalidFilter(req.query, buildLeadFilter(req.query, scope, { allowTelecaller: true }));
    const { page, limit, skip } = paginate(req);

    const [leads, total, invalidCount] = await Promise.all([
      Lead.find(filter)
        .populate("assignedTelecaller", "name email")
        .populate("convertedStudent", "name email")
        .populate("convertedBy", "name email role")
        .sort(buildLeadSort(req.query))
        .skip(skip)
        .limit(limit),
      Lead.countDocuments(filter),
      invalidLeadIds(scope).then((ids) => ids.length),
    ]);

    res.json({ leads, total, invalidCount, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteInvalidLeads = async (req, res) => {
  try {
    const { ids, all } = req.body || {};
    if (all !== true && !(Array.isArray(ids) && ids.length)) {
      return res.status(400).json({ message: "Select at least one lead" });
    }
    const deleted = await deleteInvalidLeads({ admin: req.user._id }, { ids, all: all === true });
    res.json({ deleted });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getLead = async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, admin: req.user._id })
      .populate("assignedTelecaller", "name email")
      .populate("convertedStudent", "name email")
      .populate("convertedBy", "name email role")
      .populate("callLogs.calledBy", "name email");
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json({ lead });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.reassignLead = async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, admin: req.user._id });
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const { telecallerId } = req.body;
    if (!telecallerId) return res.status(400).json({ message: "telecallerId is required" });

    const telecaller = await User.findOne({ _id: telecallerId, admin: req.user._id, role: "telecaller" });
    if (!telecaller) return res.status(400).json({ message: "Invalid telecaller" });

    lead.assignedTelecaller = telecaller._id;
    await lead.save();

    const populated = await lead.populate("assignedTelecaller", "name email");
    res.json({ lead: populated });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.registerLead = async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, admin: req.user._id });
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.convertedStudent) {
      return res.status(400).json({ message: "This lead has already been converted" });
    }

    const { name, email, password, phone, feeAmount, amountPaidNow } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email and password are required" });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: "A user with this email already exists" });
    }

    const fee = typeof feeAmount === "number" && feeAmount >= 0 ? feeAmount : lead.feeAmount || 0;
    const paidNow = typeof amountPaidNow === "number" && amountPaidNow > 0 ? amountPaidNow : 0;

    const student = await User.create({
      name,
      email,
      password,
      phone: phone || lead.phone,
      role: "student",
      admin: req.user._id,
      isActive: true,
      createdBy: req.user._id,
      installmentAmount: fee,
      balanceDue: Math.max(0, fee - paidNow),
      // Only start a payment cycle if there's actually a fee, so a 0-fee
      // student can still pick up a batch's default fee once assigned.
      nextDueDate: fee > 0 ? new Date(Date.now() + 30 * DAY_MS) : null,
    });

    if (paidNow > 0) {
      await Payment.create({
        student: student._id,
        admin: req.user._id,
        amount: paidNow,
        method: "manual",
        status: "paid",
        recordedBy: req.user._id,
        note: "Collected at registration",
      });
    }

    lead.feeAmount = fee;
    lead.convertedStudent = student._id;
    lead.convertedBy = req.user._id;
    lead.status = "converted";
    await lead.save();

    res.status(201).json({ student: student.toJSON(), lead });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.generateRegistrationLink = async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, admin: req.user._id });
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.convertedStudent) {
      return res.status(400).json({ message: "This lead has already been converted" });
    }

    const { feeAmount } = req.body;
    if (typeof feeAmount === "number" && feeAmount >= 0) {
      lead.feeAmount = feeAmount;
    }

    if (!lead.registrationToken) {
      lead.registrationToken = crypto.randomBytes(16).toString("hex");
    }
    await lead.save();

    res.json({ token: lead.registrationToken, feeAmount: lead.feeAmount });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
