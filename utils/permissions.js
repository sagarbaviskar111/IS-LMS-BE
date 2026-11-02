// What a sub-admin can be allowed to do. Each module has two levels:
//   view   - read only (GET requests)
//   manage - read and change
// Anything not listed here (settings, payment gateway, sender email, fee rules,
// storage, YouTube, managing other sub-admins...) stays with the admin only.

const MODULES = [
  { key: "leads", label: "Leads & inquiry forms", hint: "See and work on leads, build inquiry forms.", prefixes: ["/api/leads", "/api/inquiry-forms"] },
  { key: "students", label: "Students", hint: "Register, edit and archive students, student groups, registration links.", prefixes: ["/api/student-groups", "/api/enrollments"] },
  { key: "team", label: "Teachers & telecallers", hint: "Add and manage teacher and telecaller accounts.", prefixes: [] },
  { key: "academics", label: "Courses & batches", hint: "Create courses and batches, assign students.", prefixes: ["/api/courses", "/api/batches"] },
  { key: "fees", label: "Student fees", hint: "Record payments, extend deadlines, discounts and scholarships.", prefixes: ["/api/payments"] },
  { key: "finance", label: "Finance", hint: "Income, expenses and reports.", prefixes: ["/api/finance"] },
  { key: "certificates", label: "Certificates", hint: "Design templates, issue and email certificates.", prefixes: ["/api/certificates"] },
  { key: "placements", label: "Job placements", hint: "Post jobs and see interest from students.", prefixes: ["/api/jobs"] },
  { key: "tools", label: "Tools", hint: "Tools shared with students.", prefixes: ["/api/tools"] },
  { key: "announcements", label: "Send notifications", hint: "Send announcements to students, teachers and telecallers.", prefixes: [] },
];
const MODULE_KEYS = MODULES.map((m) => m.key);
const LEVELS = ["view", "manage"];

// Ready-made sets so the admin does not have to tick everything by hand.
const PRESETS = [
  { key: "admissions", label: "Admissions helper", permissions: { leads: "manage", students: "manage", academics: "view" } },
  { key: "accounts", label: "Accounts & fees", permissions: { fees: "manage", finance: "manage", students: "view" } },
  { key: "academic", label: "Academic coordinator", permissions: { academics: "manage", students: "manage", team: "view", certificates: "manage", announcements: "manage" } },
  { key: "viewer", label: "View only", permissions: { leads: "view", students: "view", team: "view", academics: "view", fees: "view", finance: "view", certificates: "view", placements: "view" } },
];

// Keeps only known modules with a valid level. Returns a clean object.
const normalizePermissions = (input) => {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const key of MODULE_KEYS) {
    if (LEVELS.includes(input[key])) out[key] = input[key];
  }
  return out;
};

const rank = (level) => LEVELS.indexOf(level); // -1 for none

const hasLevel = (permissions, module, needed) => rank((permissions || {})[module]) >= rank(needed) && rank((permissions || {})[module]) >= 0;

// Read-only data other pages need to show names (a student list shows batch and course names).
const LOOKUP_PREFIXES = ["/api/batches", "/api/courses"];
const LOOKUP_FOR = ["students", "team", "leads", "fees", "certificates", "finance"];

// Always the admin's alone.
const BLOCKED_PREFIXES = [
  "/api/users/email-settings",
  "/api/users/team-settings",
  "/api/users/lead-webhook",
  "/api/institutes",
  "/api/fee-rules",
  "/api/admin",
  "/api/subadmins",
  "/api/superadmin",
  "/api/testimonials",
];

const startsWith = (url, prefix) => url === prefix || url.startsWith(`${prefix}/`);

// Decides whether a sub-admin with these permissions may make this request.
// Returns { ok: true, module } or { ok: false, message }.
const checkAccess = (permissions, method, url) => {
  const isRead = ["GET", "HEAD", "OPTIONS"].includes(method);
  const needed = isRead ? "view" : "manage";
  const deny = (message) => ({ ok: false, message: message || "Your sub-admin account can't do this. Ask the admin for access." });

  if (BLOCKED_PREFIXES.some((p) => startsWith(url, p))) return deny("Only the admin can do this.");

  // Notifications: reading the inbox is open; sending needs the announcements module.
  if (startsWith(url, "/api/notifications")) {
    const sending = method === "POST" || startsWith(url, "/api/notifications/sent");
    if (!sending) return { ok: true, module: null };
    return hasLevel(permissions, "announcements", sending && method === "GET" ? "view" : "manage")
      ? { ok: true, module: "announcements" }
      : deny();
  }

  // Users: the controller decides per role (student / teacher / telecaller).
  if (startsWith(url, "/api/users")) {
    const ok = hasLevel(permissions, "students", needed) || hasLevel(permissions, "team", needed);
    return ok ? { ok: true, module: "people" } : deny();
  }

  for (const m of MODULES) {
    if (m.prefixes.some((p) => startsWith(url, p))) {
      if (hasLevel(permissions, m.key, needed)) return { ok: true, module: m.key };
      if (isRead && LOOKUP_PREFIXES.some((p) => startsWith(url, p)) && LOOKUP_FOR.some((k) => hasLevel(permissions, k, "view"))) {
        return { ok: true, module: m.key };
      }
      return deny();
    }
  }
  return deny();
};

module.exports = { MODULES, MODULE_KEYS, PRESETS, normalizePermissions, hasLevel, checkAccess };
