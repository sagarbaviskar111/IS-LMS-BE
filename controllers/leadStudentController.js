const Lead = require("../models/Lead");
const Course = require("../models/Course");
const StudentEnrollment = require("../models/StudentEnrollment");
const { createCourseStudent, issueEnrollmentLink, validLinkHours, summarizeEnrollment } = require("./enrollmentController");

const DEFAULT_LINK_HOURS = 72;

// One set of handlers, two audiences: an admin acts on any lead of their
// institute, a telecaller only on leads assigned to them. `loadLead` decides.
const makeLeadStudentHandlers = (loadLead) => ({
  // Converting a lead = registering a student exactly like Admin > Students >
  // Register student (course, fees taken, private link), then marking the lead
  // converted. The name / phone / email default to what the lead already has.
  registerLeadStudent: async (req, res) => {
    try {
      const { lead, error } = await loadLead(req);
      if (error) return res.status(error[0]).json({ message: error[1] });
      if (lead.convertedStudent) return res.status(400).json({ message: "This lead has already been converted" });

      const b = req.body || {};
      const out = await createCourseStudent({
        adminId: lead.admin,
        actorId: req.user._id,
        body: {
          ...b,
          name: b.name || lead.name,
          phone: b.phone || lead.phone,
          email: b.email || lead.email,
        },
      });
      if (out.error) return res.status(out.error[0]).json({ message: out.error[1] });

      lead.convertedStudent = out.student._id;
      lead.convertedBy = req.user._id;
      lead.status = "converted";
      if (out.enrollment.planTotal > 0) lead.feeAmount = out.enrollment.planTotal;
      await lead.save();

      // A link is ready straight away; it can be replaced with a different expiry.
      await issueEnrollmentLink(out.enrollment, DEFAULT_LINK_HOURS);

      res.status(201).json({
        student: out.student.toJSON(),
        enrollment: summarizeEnrollment(out.enrollment, out.course),
        lead,
      });
    } catch (err) {
      if (err && err.code === 11000) return res.status(409).json({ message: "A user with this email already exists" });
      res.status(500).json({ message: "Server error" });
    }
  },

  getLeadEnrollment: async (req, res) => {
    try {
      const { lead, error } = await loadLead(req);
      if (error) return res.status(error[0]).json({ message: error[1] });
      if (!lead.convertedStudent) return res.json({ enrollment: null });
      const enrollment = await StudentEnrollment.findOne({ student: lead.convertedStudent, admin: lead.admin });
      if (!enrollment) return res.json({ enrollment: null });
      const course = await Course.findById(enrollment.course).select("name");
      res.json({ enrollment: summarizeEnrollment(enrollment, course) });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },

  createLeadEnrollmentLink: async (req, res) => {
    try {
      const { lead, error } = await loadLead(req);
      if (error) return res.status(error[0]).json({ message: error[1] });
      if (!lead.convertedStudent) return res.status(400).json({ message: "Register this lead as a student first" });
      const enrollment = await StudentEnrollment.findOne({ student: lead.convertedStudent, admin: lead.admin });
      if (!enrollment) return res.status(404).json({ message: "This student was not registered through a course" });
      if (enrollment.usedAt) return res.status(400).json({ message: "This student has already completed registration" });

      const hours = validLinkHours(req.body?.expiresInHours);
      if (!hours) return res.status(400).json({ message: "Choose when the link should expire" });
      await issueEnrollmentLink(enrollment, hours);

      const course = await Course.findById(enrollment.course).select("name");
      res.json({ enrollment: summarizeEnrollment(enrollment, course) });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },
});

const adminLoadLead = async (req) => {
  const lead = await Lead.findOne({ _id: req.params.id, admin: req.user._id });
  return lead ? { lead } : { error: [404, "Lead not found"] };
};

const telecallerLoadLead = async (req) => {
  const lead = await Lead.findOne({ _id: req.params.id, assignedTelecaller: req.user._id });
  return lead ? { lead } : { error: [404, "Lead not found"] };
};

// Courses a telecaller can pick from when registering a lead (active ones, with
// the fee plan - no registration tokens).
const telecallerCourses = async (req, res) => {
  try {
    const courses = await Course.find({ admin: req.user.admin, isActive: true })
      .sort({ name: 1 })
      .select("name isActive oneTimeEnabled oneTimeAmount installmentEnabled installments installmentCharge")
      .lean();
    for (const c of courses) {
      c.installments = c.installments || [];
      c.installmentCharge = c.installmentCharge || 0;
    }
    res.json({ courses });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  admin: makeLeadStudentHandlers(adminLoadLead),
  telecaller: makeLeadStudentHandlers(telecallerLoadLead),
  telecallerCourses,
};
