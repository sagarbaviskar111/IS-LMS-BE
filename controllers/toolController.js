const Tool = require("../models/Tool");

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
    const tools = await Tool.find({ admin: req.user._id }).sort({ name: 1 });
    res.json({ tools });
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
    const tools = await Tool.find({ admin: req.user.admin }).sort({ name: 1 });
    res.json({ tools });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
