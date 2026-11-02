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

// Gmail's raw SMTP errors are long and confusing; say what to do instead.
const friendlyMailError = (err) => {
  const text = String(err?.message || "");
  if (err?.code === "EAUTH" || err?.responseCode === 535 || /535|Invalid login|BadCredentials/i.test(text)) {
    return {
      auth: true,
      reason:
        "Gmail rejected your sender email's App Password. Open Settings → Sender email and save a new 16-character App Password (2-Step Verification must be on).",
    };
  }
  if (/5\.4\.5|daily user sending|sending limit/i.test(text)) {
    return { reason: "Gmail's daily sending limit for this account is used up. Try again tomorrow." };
  }
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(err?.code)) {
    return { reason: "Could not reach Gmail right now. Try again in a few minutes." };
  }
  if (err?.responseCode === 550 || err?.responseCode === 553 || /recipient|user unknown|mailbox/i.test(text)) {
    return { reason: "Gmail refused this recipient address. Check that the email address is correct." };
  }
  return { reason: text.split("\n")[0].slice(0, 200) || "Could not send the email" };
};

// One mail from the institute's own Gmail, counted against the day's 90-mail cap
// (the other 10 stay free for password resets). Never throws: it returns
// { sent } or { sent: false, limited?, setup?, reason } so a bulk job keeps going.
// setup = the sender account itself is the problem (missing or wrong App Password).
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
      const f = friendlyMailError(err);
      // setup = the problem is the sender account itself, so retrying other mails is pointless.
      return { sent: false, reason: f.reason, setup: !!f.auth };
    }
  } catch (err) {
    return { sent: false, reason: err.message, setup: /sender email yet/.test(err.message) };
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

// A short "it works" mail to the account owner, so they can see the setup is right.
const sendTestEmail = async (adminId, to) =>
  sendInstituteMail(adminId, {
    to,
    subject: "Your sender email is working",
    text: "This is a test email from InstituteSathi. Your sender email is set up correctly: fee reminders, certificates and password-reset links will now go out from this address.",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="margin-bottom: 8px;">It works!</h2>
        <p>This is a test email from InstituteSathi. Your sender email is set up correctly.</p>
        <p>Fee reminders, certificates and password-reset links will now go out from this address.</p>
      </div>
    `,
  });

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

// Checks that Gmail accepts this address + App Password before it is saved.
// Only a real login rejection blocks saving; a network hiccup does not.
const verifySenderCredentials = async (address, appPassword) => {
  try {
    await nodemailer.createTransport({ service: "gmail", auth: { user: address, pass: appPassword } }).verify();
    return { ok: true };
  } catch (err) {
    const f = friendlyMailError(err);
    return f.auth
      ? {
          ok: false,
          reason:
            "Gmail did not accept this address and password. Make sure the password is the 16-letter App Password (not your normal Gmail password) and that you created it while signed in to this same Gmail account.",
        }
      : { ok: true, unchecked: true };
  }
};

module.exports = {
  verifySenderCredentials,
  saveEmailCredentials,
  sendPasswordResetEmail,
  sendFeeReminderEmail,
  sendCertificateEmail,
  sendTestEmail,
  DAILY_REMINDER_LIMIT,
  sentToday,
};
