const nodemailer = require("nodemailer");
const User = require("../models/User");
const { encrypt, decrypt } = require("./crypto");

const saveEmailCredentials = async (adminId, address, appPassword) => {
  await User.findByIdAndUpdate(adminId, {
    "emailSender.address": address,
    "emailSender.appPassword": encrypt(appPassword),
  });
};

// Each institute (and the superadmin, for their own account) sends through
// its own Gmail account — see the matching comment on the User model.
const getSenderForAdmin = async (adminId) => {
  const admin = await User.findById(adminId).select("+emailSender.appPassword");
  const address = admin?.emailSender?.address;
  const encryptedPassword = admin?.emailSender?.appPassword;
  if (!address || !encryptedPassword) {
    throw new Error("This institute hasn't set up its sender email yet");
  }
  return { address, appPassword: decrypt(encryptedPassword) };
};

// Gmail stops at about 100 mails a day. Fee reminders may use 90 of them; the
// rest is kept for password resets. Anything over waits for the next day.
const DAILY_REMINDER_LIMIT = 90;

const todayKey = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

const sentToday = (admin) => (admin?.emailQuota?.day === todayKey() ? admin.emailQuota.count || 0 : 0);

// Counts one mail against today's total. With a limit, returns false (and counts
// nothing) once the limit is reached; without one it always counts.
const claimEmailSlot = async (adminId, limit = null) => {
  const day = todayKey();
  await User.updateOne({ _id: adminId, "emailQuota.day": { $ne: day } }, { $set: { emailQuota: { day, count: 0 } } });
  const filter = { _id: adminId, "emailQuota.day": day };
  if (limit !== null) filter["emailQuota.count"] = { $lt: limit };
  const claimed = await User.findOneAndUpdate(filter, { $inc: { "emailQuota.count": 1 } });
  return !!claimed;
};

const releaseEmailSlot = (adminId) => User.updateOne({ _id: adminId }, { $inc: { "emailQuota.count": -1 } });

const sendPasswordResetEmail = async (adminId, to, resetUrl) => {
  const { address, appPassword } = await getSenderForAdmin(adminId);
  await claimEmailSlot(adminId);
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: address, pass: appPassword },
  });

  await transporter.sendMail({
    from: `"InstituteSathi" <${address}>`,
    to,
    subject: "Reset your password",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Reset your password</h2>
        <p>We received a request to reset the password for your account.</p>
        <p>
          <a href="${resetUrl}" style="display:inline-block; padding: 10px 20px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 6px;">
            Reset password
          </a>
        </p>
        <p>Or paste this link into your browser:<br>${resetUrl}</p>
        <p>This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// One mail from the institute's own Gmail, counted against the day's 90-mail cap
// (the other 10 stay free for password resets). Never throws: it returns
// { sent } or { sent: false, limited?, reason } so a bulk job keeps going.
const sendInstituteMail = async (adminId, { to, subject, text, html, attachments }) => {
  try {
    const { address, appPassword } = await getSenderForAdmin(adminId);
    if (!(await claimEmailSlot(adminId, DAILY_REMINDER_LIMIT))) {
      return { sent: false, limited: true, reason: "daily email limit reached" };
    }
    try {
      const institute = await User.findById(adminId).select("name");
      const fromName = (institute?.name || "InstituteSathi").replace(/"/g, "");
      const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: address, pass: appPassword } });
      await transporter.sendMail({ from: `"${fromName}" <${address}>`, to, subject, text, html, attachments });
      return { sent: true };
    } catch (err) {
      // The mail did not go out, so it should not use up one of today's slots.
      await releaseEmailSlot(adminId).catch(() => {});
      return { sent: false, reason: err.message };
    }
  } catch (err) {
    return { sent: false, reason: err.message };
  }
};

// Fee reminder to a student.
const sendFeeReminderEmail = async (student, { subject, text }) => {
  if (!student.email) return { sent: false, reason: "no email address" };
  if (!student.admin) return { sent: false, reason: "student has no institute" };
  const institute = await User.findById(student.admin).select("name");
  const fromName = institute?.name || "InstituteSathi";
  return sendInstituteMail(student.admin, {
    to: student.email,
    subject,
    text,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="margin-bottom: 8px;">${escapeHtml(subject)}</h2>
        <p>${escapeHtml(text)}</p>
        <p>Log in to your student dashboard to pay online and see your payment history.</p>
        <p style="color:#64748b; font-size: 13px;">${escapeHtml(fromName)}</p>
      </div>
    `,
  });
};

// A certificate PDF sent to the person it was issued to.
const sendCertificateEmail = async (adminId, { to, name, instituteName, course, certificateNo, verifyUrl, pdf, filename }) => {
  const subject = course ? `Your certificate: ${course}` : "Your certificate";
  const text = [
    `Dear ${name},`,
    "",
    `Congratulations! Your certificate${course ? ` for ${course}` : ""} from ${instituteName} is attached to this email.`,
    "",
    `Certificate no.: ${certificateNo}`,
    `Anyone can check that it is genuine here: ${verifyUrl}`,
    "",
    instituteName,
  ].join("\n");
  return sendInstituteMail(adminId, {
    to,
    subject,
    text,
    html: `
      <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto;">
        <h2 style="margin-bottom: 8px;">Congratulations, ${escapeHtml(name)}!</h2>
        <p>Your certificate${course ? ` for <strong>${escapeHtml(course)}</strong>` : ""} from ${escapeHtml(instituteName)} is attached to this email as a PDF.</p>
        <p style="color:#475569;">Certificate no.: <strong>${escapeHtml(certificateNo)}</strong></p>
        <p>
          <a href="${escapeHtml(verifyUrl)}" style="display:inline-block; padding: 10px 20px; background: #047857; color: #fff; text-decoration: none; border-radius: 6px;">
            Verify or download online
          </a>
        </p>
        <p style="color:#64748b; font-size: 13px;">${escapeHtml(instituteName)}</p>
      </div>
    `,
    attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
  });
};

module.exports = {
  saveEmailCredentials,
  sendPasswordResetEmail,
  sendFeeReminderEmail,
  sendCertificateEmail,
  DAILY_REMINDER_LIMIT,
  sentToday,
};
