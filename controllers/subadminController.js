const User = require("../models/User");
const SubadminActivity = require("../models/SubadminActivity");
const paginate = require("../utils/paginate");
const { MODULES, PRESETS, normalizePermissions } = require("../utils/permissions");

const shape = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  phone: u.phone || "",
  isActive: u.isActive,
  permissions: u.permissions || {},
  createdAt: u.createdAt,
});

// Only the admin themselves (never a sub-admin acting as the admin) manages helpers.
const adminOnly = (req, res) => {
  if (req.actor) {
    res.status(403).json({ message: "Only the admin can manage sub-admins." });
    return false;
  }
  return true;
};

const loadOwn = async (req) => User.findOne({ _id: req.params.id, role: "subadmin", admin: req.user._id });

exports.modules = (req, res) => {
  if (!adminOnly(req, res)) return;
  res.json({ modules: MODULES.map(({ key, label, hint }) => ({ key, label, hint })), presets: PRESETS });
};

exports.list = async (req, res) => {
  try {
    if (!adminOnly(req, res)) return;
    const people = await User.find({ role: "subadmin", admin: req.user._id }).sort({ createdAt: -1 });
    res.json({ subadmins: people.map(shape) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.create = async (req, res) => {
  try {
    if (!adminOnly(req, res)) return;
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "Name, email and password are required" });
    if (String(password).length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
    const permissions = normalizePermissions(req.body.permissions);
    if (Object.keys(permissions).length === 0) {
      return res.status(400).json({ message: "Choose at least one thing this sub-admin can access" });
    }
    if (await User.findOne({ email: String(email).toLowerCase().trim() })) {
      return res.status(409).json({ message: "A user with this email already exists" });
    }
    const person = await User.create({
      name: String(name).trim(),
      email,
      password,
      phone: phone ? String(phone).trim() : undefined,
      role: "subadmin",
      admin: req.user._id,
      createdBy: req.user._id,
      permissions,
    });
    res.status(201).json({ subadmin: shape(person) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.update = async (req, res) => {
  try {
    if (!adminOnly(req, res)) return;
    const person = await loadOwn(req);
    if (!person) return res.status(404).json({ message: "Sub-admin not found" });

    const { name, phone, isActive, password } = req.body;
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ message: "Name can't be empty" });
      person.name = String(name).trim();
    }
    if (phone !== undefined) person.phone = String(phone).trim();
    if (isActive !== undefined) person.isActive = !!isActive;
    if (req.body.permissions !== undefined) {
      const permissions = normalizePermissions(req.body.permissions);
      if (Object.keys(permissions).length === 0) {
        return res.status(400).json({ message: "Choose at least one thing this sub-admin can access" });
      }
      person.permissions = permissions;
      person.markModified("permissions");
    }
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
      person.password = password;
    }
    await person.save();
    res.json({ subadmin: shape(person) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.remove = async (req, res) => {
  try {
    if (!adminOnly(req, res)) return;
    const person = await loadOwn(req);
    if (!person) return res.status(404).json({ message: "Sub-admin not found" });
    await person.deleteOne();
    res.json({ message: "Sub-admin removed" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.activity = async (req, res) => {
  try {
    if (!adminOnly(req, res)) return;
    const filter = { admin: req.user._id };
    if (req.query.subadmin) filter.subadmin = req.query.subadmin;
    const { page, limit, skip } = paginate(req);
    const [rows, total] = await Promise.all([
      SubadminActivity.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("subadmin", "name"),
      SubadminActivity.countDocuments(filter),
    ]);
    res.json({
      activity: rows.map((a) => ({
        _id: a._id,
        who: a.subadmin?.name || "Removed sub-admin",
        module: a.module,
        method: a.method,
        path: a.path,
        at: a.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
