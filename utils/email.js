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

const sendPasswordResetEmail = async (adminId, to, resetUrl) => {
  const { address, appPassword } = await getSenderForAdmin(adminId);
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

module.exports = { saveEmailCredentials, sendPasswordResetEmail };
