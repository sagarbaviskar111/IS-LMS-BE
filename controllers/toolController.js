const Tool = require("../models/Tool");
const paginate = require("../utils/paginate");
const { searchRegex, pickSort, CASE_INSENSITIVE } = require("../utils/listQuery");

const TOOL_SORTS = { newest: { createdAt: -1, _id: -1 }, oldest: { createdAt: 1, _id: 1 }, name: { name: 1, _id: 1 } };

// Tools are listed A-Z by default; ?q= searches name/url, ?sort= reorders.
const toolList = (base, req) => {
  const filter = { ...base };
  const rx = searchRegex(req.query.q);
  if (rx) filter.$or = [{ name: rx }, { url: rx }];
  const sort = pickSort(req.query.sort, TOOL_SORTS, "name");
  return { filter, sort };
};

const isValidUrl = (url) => /^https?:\/\/.+/i.test(url.trim());

exports.createTool = async (req, res) => {
  try {
    const { name, url } = req.body;
    if (!name || !url) {
      return res.status(400).json({ message: "name and url are required" });
    }
    if (!isValidUrl(url)) {
      return res.status(400).json({ message: "url must start with http:// or https://" });
    }

    const tool = await Tool.create({ admin: req.user._id, name: name.trim(), url: url.trim() });
    res.status(201).json({ tool });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "You already have a tool with this name" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.listTools = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const { filter, sort } = toolList({ admin: req.user._id }, req);
    const [tools, total] = await Promise.all([
      Tool.find(filter).collation(CASE_INSENSITIVE).sort(sort).skip(skip).limit(limit),
      Tool.countDocuments(filter),
    ]);
    res.json({ tools, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateTool = async (req, res) => {
  try {
    const tool = await Tool.findOne({ _id: req.params.id, admin: req.user._id });
    if (!tool) return res.status(404).json({ message: "Tool not found" });

    const { name, url } = req.body;

    if (name !== undefined) tool.name = name.trim();
    if (url !== undefined) {
      if (!isValidUrl(url)) {
        return res.status(400).json({ message: "url must start with http:// or https://" });
      }
      tool.url = url.trim();
    }

    await tool.save();
    res.json({ tool });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "You already have a tool with this name" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteTool = async (req, res) => {
  try {
    const tool = await Tool.findOne({ _id: req.params.id, admin: req.user._id });
    if (!tool) return res.status(404).json({ message: "Tool not found" });

    await tool.deleteOne();
    res.json({ message: "Tool deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Read-only — teachers/students see the tools their own admin added.
exports.listMyInstituteTools = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const { filter, sort } = toolList({ admin: req.user.admin }, req);
    const [tools, total] = await Promise.all([
      Tool.find(filter).collation(CASE_INSENSITIVE).sort(sort).skip(skip).limit(limit),
      Tool.countDocuments(filter),
    ]);
    res.json({ tools, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
