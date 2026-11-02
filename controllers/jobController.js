const Job = require("../models/Job");
const JobInterest = require("../models/JobInterest");
const JobEmailLead = require("../models/JobEmailLead");
const Batch = require("../models/Batch");
const paginate = require("../utils/paginate");
const { searchRegex, pickSort, CASE_INSENSITIVE } = require("../utils/listQuery");
const { parseJobText } = require("../utils/aiJobParser");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A lot of real job posts just say "mail your resume to hr@company.com"
// rather than linking anywhere — rather than force that into a broken URL,
// accept a bare email as the apply link and turn it into a working mailto:
// link for students.
const normalizeApplyLink = (raw) => {
  const trimmed = raw.trim();
  const bareEmail = trimmed.replace(/^mailto:/i, "");
  if (EMAIL_RE.test(bareEmail)) {
    return { link: `mailto:${bareEmail.toLowerCase()}`, email: bareEmail.toLowerCase() };
  }
  return { link: trimmed, email: null };
};

// Keeps the superadmin-visible email-lead record in sync with the job's
// current state — created/updated when the apply link is (still) an email,
// removed if the admin later changes it to a real URL or switches modes.
const syncJobEmailLead = async (job, adminUser) => {
  const email = job.applicationMode === "link" && job.applyLink?.startsWith("mailto:")
    ? job.applyLink.slice("mailto:".length)
    : null;

  if (email) {
    await JobEmailLead.findOneAndUpdate(
      { job: job._id },
      { job: job._id, admin: adminUser._id, instituteName: adminUser.name, company: job.company, email },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } else {
    await JobEmailLead.deleteOne({ job: job._id });
  }
};

const validateJobFields = async (adminId, body) => {
  const { title, company, description, skills, responsibilities, location, visibility, batchId, applicationMode, applyLink } =
    body;

  if (!title || !company || !description) {
    throw { status: 400, message: "title, company and description are required" };
  }

  if (!["all", "batch"].includes(visibility)) {
    throw { status: 400, message: "visibility must be 'all' or 'batch'" };
  }

  let batch = null;
  if (visibility === "batch") {
    if (!batchId) throw { status: 400, message: "batchId is required when visibility is 'batch'" };
    batch = await Batch.findOne({ _id: batchId, admin: adminId });
    if (!batch) throw { status: 400, message: "Invalid batch" };
  }

  if (!["link", "interest"].includes(applicationMode)) {
    throw { status: 400, message: "applicationMode must be 'link' or 'interest'" };
  }

  if (applicationMode === "link" && !applyLink) {
    throw { status: 400, message: "applyLink is required when applicationMode is 'link'" };
  }

  return {
    title: title.trim(),
    company: company.trim(),
    description: description.trim(),
    skills: (skills || "").trim(),
    responsibilities: (responsibilities || "").trim(),
    location: (location || "").trim(),
    visibility,
    batch: batch ? batch._id : null,
    applicationMode,
    applyLink: applicationMode === "link" ? normalizeApplyLink(applyLink).link : null,
  };
};

exports.parseJobPosting = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: "Paste some job text first" });
    }

    const fields = await parseJobText(text.trim());
    res.json({ fields });
  } catch (err) {
    console.error("[job-parse] failed:", err.message);
    res.status(502).json({ message: "Could not read that job post — try filling the fields in yourself." });
  }
};

exports.createJob = async (req, res) => {
  try {
    const fields = await validateJobFields(req.user._id, req.body);
    const job = await Job.create({ admin: req.user._id, ...fields });
    await syncJobEmailLead(job, req.user);
    res.status(201).json({ job });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

exports.listJobsAdmin = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = { admin: req.user._id };
    const rx = searchRegex(req.query.q);
    if (rx) filter.$or = [{ title: rx }, { company: rx }, { location: rx }];
    if (req.query.status === "open" || req.query.status === "closed") filter.status = req.query.status;
    const sort = pickSort(
      req.query.sort,
      { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, title: { title: 1 }, company: { company: 1 } },
      "newest"
    );

    const [jobs, total] = await Promise.all([
      Job.find(filter).collation(CASE_INSENSITIVE).populate("batch", "name").sort(sort).skip(skip).limit(limit),
      Job.countDocuments(filter),
    ]);

    const interestCounts = await JobInterest.aggregate([
      { $match: { admin: req.user._id, job: { $in: jobs.map((j) => j._id) } } },
      { $group: { _id: "$job", count: { $sum: 1 } } },
    ]);
    const countByJob = Object.fromEntries(interestCounts.map((c) => [String(c._id), c.count]));

    res.json({
      jobs: jobs.map((j) => ({ ...j.toObject(), interestedCount: countByJob[String(j._id)] || 0 })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateJob = async (req, res) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, admin: req.user._id });
    if (!job) return res.status(404).json({ message: "Job not found" });

    if (req.body.status !== undefined) {
      if (!["open", "closed"].includes(req.body.status)) {
        return res.status(400).json({ message: "status must be 'open' or 'closed'" });
      }
      job.status = req.body.status;
      await job.save();
      return res.json({ job });
    }

    const fields = await validateJobFields(req.user._id, req.body);
    Object.assign(job, fields);
    await job.save();
    await syncJobEmailLead(job, req.user);
    res.json({ job });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteJob = async (req, res) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, admin: req.user._id });
    if (!job) return res.status(404).json({ message: "Job not found" });

    // JobEmailLead is deliberately kept — it's the superadmin's permanent
    // record of which companies/institutes made contact, and should survive
    // the admin deleting the job posting itself.
    await Promise.all([job.deleteOne(), JobInterest.deleteMany({ job: job._id })]);
    res.json({ message: "Job deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listJobInterests = async (req, res) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, admin: req.user._id });
    if (!job) return res.status(404).json({ message: "Job not found" });

    const interests = await JobInterest.find({ job: job._id })
      .populate("student", "name email phone")
      .sort({ createdAt: 1 });

    res.json({ interests });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Student-facing: jobs visible to them (all, or their own batch), newest first.
exports.listJobsForStudent = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = {
      admin: req.user.admin,
      $or: [{ visibility: "all" }, { visibility: "batch", batch: req.user.batch }],
    };

    const [jobs, total, myInterests] = await Promise.all([
      Job.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Job.countDocuments(filter),
      JobInterest.find({ student: req.user._id }).select("job"),
    ]);
    const interestedJobIds = new Set(myInterests.map((i) => String(i.job)));

    res.json({
      jobs: jobs.map((j) => ({ ...j.toObject(), interested: interestedJobIds.has(String(j._id)) })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Superadmin-facing: every job posting where an admin pasted an HR email
// instead of a real apply link, across every institute on the platform.
exports.listJobEmailLeads = async (req, res) => {
  try {
    const listQuery = require("../utils/listQuery");
    const { page, limit, skip } = paginate(req);
    const filter = {};
    const rx = listQuery.searchRegex(req.query.q);
    if (rx) filter.$or = [{ company: rx }, { email: rx }, { instituteName: rx }];
    const sort = listQuery.pickSort(
      req.query.sort,
      {
        newest: { createdAt: -1 },
        oldest: { createdAt: 1 },
        company_asc: { company: 1, _id: 1 },
        institute_asc: { instituteName: 1, _id: 1 },
      },
      "newest"
    );
    const [leads, total] = await Promise.all([
      JobEmailLead.find(filter).collation(listQuery.CASE_INSENSITIVE).sort(sort).skip(skip).limit(limit),
      JobEmailLead.countDocuments(filter),
    ]);

    res.json({
      leads,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.expressInterest = async (req, res) => {
  try {
    const job = await Job.findOne({
      _id: req.params.id,
      admin: req.user.admin,
      applicationMode: "interest",
      $or: [{ visibility: "all" }, { visibility: "batch", batch: req.user.batch }],
    });
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (job.status !== "open") return res.status(400).json({ message: "This job is no longer open" });

    await JobInterest.updateOne(
      { job: job._id, student: req.user._id },
      { $setOnInsert: { admin: req.user.admin } },
      { upsert: true }
    );

    res.json({ message: "Marked as interested" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
