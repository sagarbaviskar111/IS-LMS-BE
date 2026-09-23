const Session = require("../models/Session");
const Attendance = require("../models/Attendance");

const MAX_BULK_DATES = 31;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isAssigned = (req, batchId) =>
  (req.user.batches || []).some((b) => String(b) === String(batchId));

const validateTimes = (startTime, endTime) => {
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    return "startTime and endTime must be in HH:mm format";
  }
  if (startTime >= endTime) {
    return "endTime must be after startTime";
  }
  return null;
};

const URL_RE = /^https?:\/\/.+/i;

const validateMeetingLink = (meetingLink) => {
  if (!meetingLink) return null;
  if (!URL_RE.test(meetingLink)) {
    return "meetingLink must be a valid http(s) URL";
  }
  return null;
};

exports.createSession = async (req, res) => {
  try {
    const { batch, topic, date, startTime, endTime, notes, meetingLink } = req.body;
    if (!batch || !topic || !date || !startTime || !endTime) {
      return res
        .status(400)
        .json({ message: "batch, topic, date, startTime and endTime are required" });
    }
    if (!isAssigned(req, batch)) {
      return res.status(403).json({ message: "You are not assigned to this batch" });
    }

    const timeError = validateTimes(startTime, endTime);
    if (timeError) return res.status(400).json({ message: timeError });

    const linkError = validateMeetingLink(meetingLink);
    if (linkError) return res.status(400).json({ message: linkError });

    const session = await Session.create({
      batch,
      admin: req.user.admin,
      createdBy: req.user._id,
      topic,
      date: new Date(date),
      startTime,
      endTime,
      notes,
      meetingLink,
    });

    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.createBulkSessions = async (req, res) => {
  try {
    const { batch, topic, dates, startTime, endTime, notes, meetingLink } = req.body;
    if (!batch || !topic || !Array.isArray(dates) || dates.length === 0 || !startTime || !endTime) {
      return res
        .status(400)
        .json({ message: "batch, topic, dates, startTime and endTime are required" });
    }
    if (!isAssigned(req, batch)) {
      return res.status(403).json({ message: "You are not assigned to this batch" });
    }
    if (dates.length > MAX_BULK_DATES) {
      return res.status(400).json({ message: `Cannot create more than ${MAX_BULK_DATES} sessions at once` });
    }

    const timeError = validateTimes(startTime, endTime);
    if (timeError) return res.status(400).json({ message: timeError });

    const linkError = validateMeetingLink(meetingLink);
    if (linkError) return res.status(400).json({ message: linkError });

    const docs = dates.map((d) => ({
      batch,
      admin: req.user.admin,
      createdBy: req.user._id,
      topic,
      date: new Date(d),
      startTime,
      endTime,
      notes,
      meetingLink,
    }));

    const sessions = await Session.insertMany(docs);
    res.status(201).json({ sessions });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.listSessions = async (req, res) => {
  try {
    const { batch, from, to } = req.query;
    if (!batch) return res.status(400).json({ message: "batch is required" });
    if (!isAssigned(req, batch)) {
      return res.status(403).json({ message: "You are not assigned to this batch" });
    }

    const filter = { batch };
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }

    const sessions = await Session.find(filter).sort({ date: 1, startTime: 1 });

    const marked = await Attendance.find({ session: { $in: sessions.map((s) => s._id) } }).select(
      "session"
    );
    const markedSet = new Set(marked.map((a) => String(a.session)));

    res.json({
      sessions: sessions.map((s) => ({
        ...s.toObject(),
        attendanceMarked: markedSet.has(String(s._id)),
      })),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateSession = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (!isAssigned(req, session.batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { topic, date, startTime, endTime, notes, meetingLink } = req.body;
    if (topic !== undefined) session.topic = topic;
    if (date !== undefined) session.date = new Date(date);
    if (startTime !== undefined) session.startTime = startTime;
    if (endTime !== undefined) session.endTime = endTime;
    if (notes !== undefined) session.notes = notes;
    if (meetingLink !== undefined) session.meetingLink = meetingLink;

    const timeError = validateTimes(session.startTime, session.endTime);
    if (timeError) return res.status(400).json({ message: timeError });

    const linkError = validateMeetingLink(session.meetingLink);
    if (linkError) return res.status(400).json({ message: linkError });

    await session.save();
    res.json({ session });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteSession = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (!isAssigned(req, session.batch)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await session.deleteOne();
    res.json({ message: "Session deleted" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
