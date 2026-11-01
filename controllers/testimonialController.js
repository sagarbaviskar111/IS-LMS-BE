const mongoose = require("mongoose");
const Testimonial = require("../models/Testimonial");

const MAX_IMPORT = 12;

const shape = (t) => ({
  _id: t._id,
  quote: t.quote,
  name: t.name,
  role: t.role,
  city: t.city,
  isActive: t.isActive,
  order: t.order,
});

const readBody = (b) => {
  const quote = String(b?.quote || "").trim().slice(0, 600);
  const name = String(b?.name || "").trim().slice(0, 80);
  if (!quote) return { error: "Write the review text" };
  if (!name) return { error: "Add the reviewer's name" };
  return {
    value: {
      quote,
      name,
      role: String(b?.role || "").trim().slice(0, 120),
      city: String(b?.city || "").trim().slice(0, 60),
    },
  };
};

// Public - feeds the landing page. An empty list tells the page to keep
// showing its built-in reviews.
exports.publicList = async (req, res) => {
  try {
    const rows = await Testimonial.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).limit(24);
    res.json({ testimonials: rows.map(shape) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.manageList = async (req, res) => {
  try {
    const rows = await Testimonial.find({}).sort({ order: 1, createdAt: 1 });
    res.json({ testimonials: rows.map(shape) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.create = async (req, res) => {
  try {
    const { value, error } = readBody(req.body);
    if (error) return res.status(400).json({ message: error });
    const last = await Testimonial.findOne({}).sort({ order: -1 }).select("order");
    const t = await Testimonial.create({
      ...value,
      isActive: req.body?.isActive !== false,
      order: (last?.order ?? -1) + 1,
    });
    res.status(201).json({ testimonial: shape(t) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.update = async (req, res) => {
  try {
    const t = await Testimonial.findById(req.params.id).catch(() => null);
    if (!t) return res.status(404).json({ message: "Review not found" });
    const b = req.body || {};
    if (b.quote !== undefined || b.name !== undefined || b.role !== undefined || b.city !== undefined) {
      const { value, error } = readBody({ quote: t.quote, name: t.name, role: t.role, city: t.city, ...b });
      if (error) return res.status(400).json({ message: error });
      Object.assign(t, value);
    }
    if (b.isActive !== undefined) t.isActive = !!b.isActive;
    if (b.order !== undefined && Number.isFinite(Number(b.order))) t.order = Number(b.order);
    await t.save();
    res.json({ testimonial: shape(t) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.remove = async (req, res) => {
  try {
    const t = await Testimonial.findByIdAndDelete(req.params.id).catch(() => null);
    if (!t) return res.status(404).json({ message: "Review not found" });
    res.json({ message: "Review deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Copies the landing page's built-in reviews into the database so they can be
// edited. Only allowed while the list is empty, so it can't create duplicates.
exports.importDefaults = async (req, res) => {
  try {
    if (await Testimonial.exists({})) return res.status(409).json({ message: "Reviews already exist" });
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, MAX_IMPORT);
    const docs = [];
    for (const it of items) {
      const { value, error } = readBody(it);
      if (!error) docs.push({ ...value, isActive: true, order: docs.length });
    }
    if (!docs.length) return res.status(400).json({ message: "Nothing to import" });
    const created = await Testimonial.insertMany(docs);
    res.status(201).json({ testimonials: created.map(shape) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
