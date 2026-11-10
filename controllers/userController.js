const crypto = require("crypto");
const { studentCapacityError } = require("../utils/billing");
const User = require("../models/User");
const Batch = require("../models/Batch");
const Payment = require("../models/Payment");
const StudentEnrollment = require("../models/StudentEnrollment");
const generateInviteCode = require("../utils/inviteCode");
const paginate = require("../utils/paginate");
const mongoose = require("mongoose");
const { searchRegex, pickSort, CASE_INSENSITIVE } = require("../utils/listQuery");
const { DAY_MS } = require("../utils/paymentCycle");
const { generateUniqueSlug } = require("../utils/slug");
const { saveEmailCredentials, verifySenderCredentials, sendTestEmail: sendTestEmailTo, sentToday, DAILY_REMINDER_LIMIT } = require("../utils/email");
const { hasLevel } = require("../utils/permissions");

// PUBLIC_API_URL (e.g. https://api.example.com, or an ngrok URL while testing
// locally) wins over the request's own host: external senders like Google
// Sheets can only reach a public address, never localhost.
const buildWebhookUrl = (req, apiKey) => {
  const base = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  return `${base}/api/leads/webhook/${apiKey}`;
};

// Roles each role is allowed to create/manage.
// superadmin only manages coaching-class admins.
// admin only manages their own tenant's student/teacher/telecaller accounts.
const MANAGEABLE_ROLES = {
  superadmin: ["admin"],
  admin: ["student", "teacher", "telecaller"],
};

const canManageRole = (actorRole, targetRole) => {
  const allowed = MANAGEABLE_ROLES[actorRole] || [];
  return allowed.includes(targetRole);
};

// A sub-admin may only manage the kinds of account its permissions cover, and only change
// them when it has "manage" (view is read only).
const canManage = (req, targetRole) => {
  if (!canManageRole(req.user.role, targetRole)) return false;
  if (!req.actor) return true;
  const need = ["GET", "HEAD"].includes(req.method) ? "view" : "manage";
  return hasLevel(req.actor.permissions, targetRole === "student" ? "students" : "team", need);
};

const isSameTenant = (actor, user) => {
  if (actor.role === "superadmin") return true;
  if (actor.role === "admin") return user.admin && String(user.admin) === String(actor._id);
  return false;
};

const uniqueInviteCode = async (taken = []) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInviteCode();
    if (taken.includes(code)) continue;
    const exists = await User.findOne({
      $or: [{ studentInviteCode: code }, { teacherInviteCode: code }, { telecallerInviteCode: code }],
    });
    if (!exists) return code;
  }
  throw new Error("Could not generate a unique invite code");
};

const generateTenantInviteCodes = async () => {
  const studentInviteCode = await uniqueInviteCode();
  const teacherInviteCode = await uniqueInviteCode([studentInviteCode]);
  const telecallerInviteCode = await uniqueInviteCode([studentInviteCode, teacherInviteCode]);
  return { studentInviteCode, teacherInviteCode, telecallerInviteCode };
};

exports.generateTenantInviteCodes = generateTenantInviteCodes;

// Students belong to exactly one batch (or none). Returns the batch doc (not
// just its id) so callers can default payment terms from it.
const resolveStudentBatch = async (adminId, batchId) => {
  if (!batchId) return null;
  const batch = await Batch.findOne({ _id: batchId, admin: adminId });
  if (!batch) throw new Error("Invalid batch");
  return batch;
};

// A student who doesn't already have a payment cycle running (no fee decided
// at registration) picks up the batch's default fee/cycle on assignment.
const applyBatchPaymentDefaults = (student, batch) => {
  if (!batch || student.nextDueDate || !batch.defaultFee) return;
  student.installmentAmount = batch.defaultFee;
  student.balanceDue = batch.defaultFee;
  student.nextDueDate = new Date(Date.now() + (batch.paymentCycleDays || 30) * DAY_MS);
};

// Teachers can be assigned to any number of batches.
const resolveTeacherBatches = async (adminId, batchIds) => {
  if (!Array.isArray(batchIds)) throw new Error("batches must be an array");
  const unique = [...new Set(batchIds)];
  if (unique.length === 0) return [];
  const found = await Batch.find({ _id: { $in: unique }, admin: adminId });
  if (found.length !== unique.length) throw new Error("One or more batches are invalid");
  return found.map((b) => b._id);
};

exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role, phone, installmentAmount, amountPaidNow } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "name, email, password and role are required" });
    }

    if (!canManage(req, role)) {
      return res.status(403).json({ message: `You are not allowed to create a ${role} account` });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: "A user with this email already exists" });
    }

    if (role === "student") {
      const capErr = await studentCapacityError(req.user._id);
      if (capErr) return res.status(403).json({ message: capErr });
    }

    const payload = {
      name,
      email,
      password,
      role,
      phone,
      createdBy: req.user._id,
      isActive: true,
    };

    if (role === "admin") {
      Object.assign(payload, await generateTenantInviteCodes());
      payload.instituteSlug = await generateUniqueSlug(name);
    } else {
      // student / teacher / telecaller created directly by their admin
      payload.admin = req.user._id;
    }

    let batchDoc = null;
    try {
      if (role === "student" && req.body.batch !== undefined) {
        batchDoc = await resolveStudentBatch(req.user._id, req.body.batch);
        payload.batch = batchDoc ? batchDoc._id : null;
      }
      if (role === "teacher" && req.body.batches !== undefined) {
        payload.batches = await resolveTeacherBatches(req.user._id, req.body.batches);
      }
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    let paidNow = 0;
    if (role === "student") {
      // Explicit fee wins; otherwise fall back to the batch's default fee (if any).
      const fee =
        typeof installmentAmount === "number" && installmentAmount >= 0
          ? installmentAmount
          : batchDoc?.defaultFee || 0;
      paidNow = typeof amountPaidNow === "number" && amountPaidNow > 0 ? amountPaidNow : 0;
      payload.installmentAmount = fee;
      payload.balanceDue = Math.max(0, fee - paidNow);
      // Only start a payment cycle if there's actually a fee — a 0-fee student
      // with no batch yet should be free to pick up a batch's default fee later.
      if (fee > 0) {
        const cycleDays = batchDoc?.paymentCycleDays || 30;
        payload.nextDueDate = new Date(Date.now() + cycleDays * DAY_MS);
      }
    }

    const user = await User.create(payload);

    if (role === "student" && paidNow > 0) {
      await Payment.create({
        student: user._id,
        admin: req.user._id,
        batch: user.batch || null,
        amount: paidNow,
        method: "manual",
        status: "paid",
        recordedBy: req.user._id,
        note: "Collected at registration",
      });
    }

    res.status(201).json({ user: user.toJSON() });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

const MAX_BULK_ROWS = 500;

// Rows already parsed client-side (from a CSV/Excel upload) — this endpoint
// only ever creates student/teacher/telecaller accounts for the calling
// admin's own institute, same as createUser one at a time, just looped.
// Never fails the whole batch for one bad row: everything resolvable gets
// created, everything else comes back in `skipped` with why.
exports.bulkCreateUsers = async (req, res) => {
  try {
    const { role, rows } = req.body;
    if (!["student", "teacher", "telecaller"].includes(role) || !canManage(req, role)) {
      return res.status(403).json({ message: `You are not allowed to create ${role} accounts` });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "rows must be a non-empty array" });
    }
    if (rows.length > MAX_BULK_ROWS) {
      return res.status(400).json({ message: `Upload at most ${MAX_BULK_ROWS} rows at a time` });
    }

    // Batch names are resolved once up front rather than per row.
    const batches =
      role === "student" || role === "teacher" ? await Batch.find({ admin: req.user._id }) : [];
    const batchByName = new Map(batches.map((b) => [b.name.trim().toLowerCase(), b]));

    const created = [];
    const skipped = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] || {};
      const rowNum = i + 1;
      const name = String(row.name || "").trim();
      const email = String(row.email || "").trim().toLowerCase();
      const phone = row.phone ? String(row.phone).trim() : undefined;

      if (!name || !email) {
        skipped.push({ row: rowNum, name, email, reason: "Missing name or email" });
        continue;
      }

      const existing = await User.findOne({ email });
      if (existing) {
        skipped.push({ row: rowNum, name, email, reason: "Email already exists" });
        continue;
      }

      const providedPassword = row.password ? String(row.password) : null;
      const password = providedPassword || crypto.randomBytes(6).toString("hex");

      const payload = {
        name,
        email,
        password,
        role,
        phone,
        createdBy: req.user._id,
        admin: req.user._id,
        isActive: true,
      };

      if (role === "student" && row.batch) {
        const batch = batchByName.get(String(row.batch).trim().toLowerCase());
        if (!batch) {
          skipped.push({ row: rowNum, name, email, reason: `Batch "${row.batch}" not found` });
          continue;
        }
        payload.batch = batch._id;
        if (batch.defaultFee) {
          payload.installmentAmount = batch.defaultFee;
          payload.balanceDue = batch.defaultFee;
          payload.nextDueDate = new Date(Date.now() + (batch.paymentCycleDays || 30) * DAY_MS);
        }
      }

      if (role === "teacher" && row.batches) {
        const names = String(row.batches)
          .split(/[,;]/)
          .map((n) => n.trim().toLowerCase())
          .filter(Boolean);
        const resolvedIds = [];
        const missing = names.find((n) => !batchByName.has(n));
        if (missing) {
          skipped.push({ row: rowNum, name, email, reason: `Batch "${missing}" not found` });
          continue;
        }
        for (const n of names) resolvedIds.push(batchByName.get(n)._id);
        payload.batches = resolvedIds;
      }

      try {
        const user = await User.create(payload);
        created.push({
          row: rowNum,
          name: user.name,
          email: user.email,
          // Only echoed back when we generated it — if the sheet already had
          // a password, the admin already has it, no need to repeat it.
          password: providedPassword ? undefined : password,
        });
      } catch (err) {
        skipped.push({ row: rowNum, name, email, reason: err.message || "Could not create account" });
      }
    }

    res.status(201).json({ created, skipped });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listUsers = async (req, res) => {
  try {
    const allowedRoles = (MANAGEABLE_ROLES[req.user.role] || []).filter((r) => canManage(req, r));
    if (allowedRoles.length === 0) return res.status(403).json({ message: "Not authorized to view users" });
    const filter = { role: { $in: allowedRoles } };

    if (req.query.role) {
      if (!allowedRoles.includes(req.query.role)) {
        return res.status(403).json({ message: "Not authorized to view this role" });
      }
      filter.role = req.query.role;
    }

    if (req.user.role === "admin") {
      filter.admin = req.user._id;
    }

    if (req.query.status === "pending") {
      filter.pending = true;
    } else if (req.query.status === "team") {
      // Already-approved users, active or deactivated — excludes the pending queue.
      filter.pending = { $ne: true };
    } else if (req.query.status === "active") {
      filter.isActive = true;
    } else if (req.query.status === "inactive") {
      filter.isActive = false;
      filter.pending = { $ne: true };
    }

    // ---- optional search / filters / sorting for the admin lists ----
    const rx = searchRegex(req.query.q);
    if (rx) filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
    if (req.query.active === "1") filter.isActive = true;
    if (req.query.active === "0") filter.isActive = false;
    if (req.query.registration === "pending") filter.registrationComplete = false;
    if (mongoose.isValidObjectId(req.query.course)) filter.course = req.query.course;
    const batchQ = req.query.batch;
    if (filter.role === "student") {
      if (batchQ === "none") filter.batch = null;
      else if (mongoose.isValidObjectId(batchQ)) filter.batch = batchQ;
    } else if (filter.role === "teacher") {
      if (batchQ === "none") filter.batches = { $size: 0 };
      else if (mongoose.isValidObjectId(batchQ)) filter.batches = batchQ;
    }
    const sort = pickSort(
      req.query.sort,
      {
        newest: { createdAt: -1 },
        oldest: { createdAt: 1 },
        name_asc: { name: 1, _id: 1 },
        name_desc: { name: -1, _id: 1 },
        email_asc: { email: 1, _id: 1 },
        email_desc: { email: -1, _id: 1 },
      },
      "newest"
    );

    // Archived students are only shown when asked for, and then only they are.
    const archived = req.query.archived === "1";
    if (archived) filter.archivedAt = { $ne: null };
    const { page, limit, skip } = paginate(req);
    const [users, total] = await Promise.all([
      User.find(filter)
        .setOptions({ withArchived: archived })
        .collation(CASE_INSENSITIVE)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate("course", "name"),
      User.countDocuments(filter).setOptions({ withArchived: archived }),
    ]);
    res.json({ users, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!canManage(req, user.role) || !isSameTenant(req.user, user)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!canManage(req, user.role) || !isSameTenant(req.user, user)) {
      return res.status(403).json({ message: "Not authorized to modify this user" });
    }

    const {
      name,
      phone,
      isActive,
      password,
      deactivationMessage,
      recordingBlockFrom,
      recordingBlockTo,
    } = req.body;
    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (isActive !== undefined) {
      user.isActive = isActive;
      // Approving a self-registered account clears it from the pending queue.
      if (isActive) {
        user.pending = false;
        // Reactivating via the generic toggle also clears a payment-deactivation flag.
        user.deactivatedForPayment = false;
        user.paymentGraceUntil = null;
        user.deactivationMessage = null;
      }
    }
    // Setting a message alongside isActive:false lets an admin show a specific
    // reason (e.g. dues pending) instead of the generic deactivated message.
    if (isActive !== true && deactivationMessage !== undefined) {
      user.deactivationMessage = deactivationMessage ? String(deactivationMessage).trim() : null;
    }
    if (password) user.password = password;

    if (user.role === "student") {
      if (recordingBlockFrom !== undefined) {
        const from = recordingBlockFrom ? new Date(recordingBlockFrom) : null;
        if (from && Number.isNaN(from.getTime())) {
          return res.status(400).json({ message: "Invalid recordingBlockFrom date" });
        }
        user.recordingBlockFrom = from;
        // Clearing the start clears the whole block — a dangling end date
        // with no start would otherwise silently do nothing.
        if (!from) user.recordingBlockTo = null;
      }
      if (recordingBlockTo !== undefined) {
        const to = recordingBlockTo ? new Date(recordingBlockTo) : null;
        if (to && Number.isNaN(to.getTime())) {
          return res.status(400).json({ message: "Invalid recordingBlockTo date" });
        }
        if (to && user.recordingBlockFrom && to < user.recordingBlockFrom) {
          return res.status(400).json({ message: "recordingBlockTo cannot be before recordingBlockFrom" });
        }
        user.recordingBlockTo = to;
      }
    }

    try {
      if (user.role === "student" && req.body.batch !== undefined) {
        const batchDoc = await resolveStudentBatch(req.user._id, req.body.batch);
        user.batch = batchDoc ? batchDoc._id : null;
        applyBatchPaymentDefaults(user, batchDoc);
      }
      if (user.role === "teacher" && req.body.batches !== undefined) {
        user.batches = await resolveTeacherBatches(req.user._id, req.body.batches);
      }
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    await user.save();
    res.json({ user: user.toJSON() });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!canManage(req, user.role) || !isSameTenant(req.user, user)) {
      return res.status(403).json({ message: "Not authorized to delete this user" });
    }

    // A student who has been part of the institute is archived, not erased, so
    // attendance, submissions and notifications keep pointing at a real account.
    // A rejected sign-up request (pending) never took part in anything: remove it.
    if (user.role === "student" && !user.pending) {
      user.archivedAt = new Date();
      user.isActive = false;
      await user.save();
      return res.json({ message: "Student archived", archived: true });
    }

    await user.deleteOne();
    // An admin-registered student's private registration link goes with them.
    await StudentEnrollment.deleteMany({ student: user._id });
    res.json({ message: "User deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.restoreUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).setOptions({ withArchived: true });
    if (!user || !user.archivedAt) return res.status(404).json({ message: "Archived student not found" });

    if (!canManage(req, user.role) || !isSameTenant(req.user, user)) {
      return res.status(403).json({ message: "Not authorized to restore this user" });
    }

    user.archivedAt = null;
    user.isActive = true;
    user.deactivationMessage = null;
    await user.save();
    res.json({ user: user.toJSON() });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getEmailSettings = async (req, res) => {
  res.json({
    address: req.user.emailSender?.address || null,
    hasCredentials: !!req.user.emailSender?.address,
    sentToday: sentToday(req.user),
    reminderLimit: DAILY_REMINDER_LIMIT,
  });
};

exports.updateEmailSettings = async (req, res) => {
  try {
    const { address, appPassword } = req.body;
    if (!address || !appPassword) {
      return res.status(400).json({ message: "address and appPassword are required" });
    }
    // Google shows the App Password as four groups with spaces; the spaces are not part of it.
    const cleanAddress = String(address).trim().toLowerCase();
    const cleanPassword = String(appPassword).replace(/\s+/g, "");
    const check = await verifySenderCredentials(cleanAddress, cleanPassword);
    if (!check.ok) return res.status(400).json({ message: check.reason });
    await saveEmailCredentials(req.user._id, cleanAddress, cleanPassword);
    res.json({ message: "Sender email saved." });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Sends a test mail to the logged-in admin so they can confirm the sender works.
exports.sendTestEmail = async (req, res) => {
  try {
    if (!req.user.emailSender?.address) {
      return res.status(400).json({ message: "Save your sender email first." });
    }
    const r = await sendTestEmailTo(req.user._id, req.user.email);
    if (!r.sent) return res.status(r.limited ? 429 : 400).json({ message: r.limited ? "Today's email limit is reached. Try again tomorrow." : r.reason });
    res.json({ message: `Test email sent to ${req.user.email}. Check your inbox (and spam).`, to: req.user.email });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getLeadWebhookSettings = async (req, res) => {
  try {
    let apiKey = req.user.leadWebhookKey;
    if (!apiKey) {
      apiKey = crypto.randomBytes(24).toString("hex");
      req.user.leadWebhookKey = apiKey;
      await req.user.save();
    }
    res.json({ apiKey, webhookUrl: buildWebhookUrl(req, apiKey) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.regenerateLeadWebhookKey = async (req, res) => {
  try {
    const apiKey = crypto.randomBytes(24).toString("hex");
    req.user.leadWebhookKey = apiKey;
    await req.user.save();
    res.json({ apiKey, webhookUrl: buildWebhookUrl(req, apiKey) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getTeamSettings = async (req, res) => {
  res.json({ allowSelfPasswordReset: !!req.user.allowSelfPasswordReset });
};

exports.updateTeamSettings = async (req, res) => {
  try {
    const { allowSelfPasswordReset } = req.body;
    if (typeof allowSelfPasswordReset !== "boolean") {
      return res.status(400).json({ message: "allowSelfPasswordReset must be a boolean" });
    }
    req.user.allowSelfPasswordReset = allowSelfPasswordReset;
    await req.user.save();
    res.json({ allowSelfPasswordReset: req.user.allowSelfPasswordReset });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
