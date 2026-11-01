const crypto = require("crypto");
const fs = require("fs");
const User = require("../models/User");
const Lead = require("../models/Lead");
const Payment = require("../models/Payment");
const Notification = require("../models/Notification");
const generateToken = require("../utils/generateToken");
const { closeOutIfFullyPaid } = require("../utils/feeStatus");
const { hasSchedule, applyPayment } = require("../utils/installmentSchedule");
const { getRazorpay } = require("../utils/razorpay");
const { DAY_MS, enforceFeeDeadline } = require("../utils/paymentCycle");
const { resolveInstitute } = require("../utils/institute");
const { sendPasswordResetEmail } = require("../utils/email");
const { uploadFile, deleteFile, resolveResourceType } = require("../utils/cloudinary");

const ROLE_LABELS = { student: "Students", teacher: "Teachers", telecaller: "Telecallers" };

const RESET_TOKEN_EXPIRE_MS = 30 * 60 * 1000; // 30 minutes

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  // Lets the cookie set by the API subdomain (api.example.com) be read on
  // the frontend's own domain (example.com) too — without this, a browser
  // scopes the cookie to the exact host that set it, so Next.js middleware
  // on the frontend domain never sees it and treats every request as logged
  // out. Unset in dev, where frontend/backend share the "localhost" host
  // (just different ports) and cookies are already shared there.
  domain: process.env.COOKIE_DOMAIN || undefined,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// Maps each self-registerable role to the admin field that grants it.
// The invite code the client submits determines the role — a role field
// from the request body is never trusted.
const INVITE_CODE_FIELDS = {
  student: "studentInviteCode",
  teacher: "teacherInviteCode",
  telecaller: "telecallerInviteCode",
};

const findAdminByInviteCode = async (inviteCode) => {
  for (const [role, field] of Object.entries(INVITE_CODE_FIELDS)) {
    const admin = await User.findOne({ role: "admin", isActive: true, [field]: inviteCode });
    if (admin) return { admin, role };
  }
  return null;
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select("+password");
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Fees overdue past the extra days: block now, not at the next job run.
    await enforceFeeDeadline(user);

    if (!user.isActive) {
      let message = "Your account has been deactivated. Please check with your teacher or admin.";
      if (user.pending) {
        message = "Your account is pending admin approval. Please check back later.";
      } else if (user.paymentPending) {
        message = "Your registration payment hasn't been completed yet. Use the registration link you were sent to finish paying.";
      } else if (user.deactivationMessage) {
        // Admin-set custom message (e.g. a specific dues reminder) always wins
        // over the generic payment-deactivation default below.
        message = user.deactivationMessage;
      } else if (user.deactivatedForPayment) {
        message =
          "Your account is deactivated due to a pending payment due. Please clear your dues, or in an emergency contact your admin or teacher for more time.";
      }
      // A student blocked only for unpaid fees can clear them online right
      // from the login screen (see createDuesPaymentOrder).
      const canPayOnline = !!user.deactivatedForPayment && user.balanceDue > 0;
      return res.status(403).json({ message, deactivatedForPayment: !!user.deactivatedForPayment, canPayOnline });
    }

    const institute = await resolveInstitute(user);
    // superadmin isn't tied to any institute — routed under the fixed
    // /platform prefix instead (reserved in utils/slug.js).
    const instituteSlug = user.role === "superadmin" ? "platform" : institute?.slug;
    const token = generateToken(user, instituteSlug);
    res.cookie("token", token, cookieOptions);
    res.json({ user: user.toJSON(), institute });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Development-only shortcut: signs in as the first active user of the given
// role under DEV_LOGIN_INSTITUTE (default "test-admin") without a password.
// Hard-disabled unless NODE_ENV is "development".
exports.devLogin = async (req, res) => {
  if (process.env.NODE_ENV !== "development") {
    return res.status(404).json({ message: "Not found" });
  }
  try {
    const { role } = req.body;
    if (!["admin", "teacher", "student", "telecaller"].includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    const slug = (process.env.DEV_LOGIN_INSTITUTE || "test-admin").toLowerCase();
    const admin = await User.findOne({ role: "admin", instituteSlug: slug });
    if (!admin) {
      return res.status(404).json({ message: `Institute "${slug}" not found` });
    }

    const user =
      role === "admin"
        ? admin
        : await User.findOne({ role, admin: admin._id, isActive: true }).sort({ createdAt: 1 });
    if (!user) {
      return res.status(404).json({ message: `No active ${role} in "${slug}"` });
    }

    const institute = await resolveInstitute(user);
    res.cookie("token", generateToken(user, institute?.slug), cookieOptions);
    res.json({ user: user.toJSON(), institute });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.inviteInfo =async (req, res) => {
  try {
    const inviteCode = (req.query.code || "").toString();
    if (!inviteCode) {
      return res.status(400).json({ message: "code is required" });
    }

    const match = await findAdminByInviteCode(inviteCode);
    if (!match) {
      return res.status(404).json({ message: "Invalid invite code" });
    }

    res.json({ role: match.role, coachingClassName: match.admin.name });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.register = async (req, res) => {
  try {
    const { name, email, password, phone, inviteCode } = req.body;

    if (!name || !email || !password || !inviteCode) {
      return res
        .status(400)
        .json({ message: "name, email, password and inviteCode are required" });
    }

    const match = await findAdminByInviteCode(inviteCode);
    if (!match) {
      return res.status(400).json({ message: "Invalid invite code" });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: "A user with this email already exists" });
    }

    const user = await User.create({
      name,
      email,
      password,
      role: match.role,
      phone,
      admin: match.admin._id,
      isActive: false,
      pending: true,
    });

    res.status(201).json({
      message: "Registration submitted. An admin needs to approve your account before you can log in.",
      user: user.toJSON(),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.leadInfo = async (req, res) => {
  try {
    const token = (req.query.token || "").toString();
    if (!token) {
      return res.status(400).json({ message: "token is required" });
    }

    const lead = await Lead.findOne({ registrationToken: token });
    if (!lead) {
      return res.status(404).json({ message: "Invalid or expired registration link" });
    }
    if (lead.convertedStudent) {
      return res.status(410).json({ message: "This registration link has already been used" });
    }

    const admin = await User.findById(lead.admin);
    res.json({
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      feeAmount: lead.feeAmount || 0,
      coachingClassName: admin?.name || "",
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.registerViaLead = async (req, res) => {
  try {
    const { token, name, email, password, phone } = req.body;
    if (!token || !name || !email || !password) {
      return res.status(400).json({ message: "token, name, email and password are required" });
    }

    const lead = await Lead.findOne({ registrationToken: token });
    if (!lead) {
      return res.status(404).json({ message: "Invalid or expired registration link" });
    }
    if (lead.convertedStudent) {
      return res.status(410).json({ message: "This registration link has already been used" });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: "A user with this email already exists" });
    }

    // A fee was set on this lead — the account is created but stays inactive
    // until the registration payment is verified.
    const requiresPayment = (lead.feeAmount || 0) > 0;

    const student = await User.create({
      name,
      email,
      password,
      phone: phone || lead.phone,
      role: "student",
      admin: lead.admin,
      isActive: !requiresPayment,
      paymentPending: requiresPayment,
      installmentAmount: lead.feeAmount || 0,
      balanceDue: lead.feeAmount || 0,
      nextDueDate: requiresPayment ? new Date(Date.now() + 30 * DAY_MS) : null,
    });

    lead.convertedStudent = student._id;
    lead.status = "converted";
    await lead.save();

    if (requiresPayment) {
      return res.status(201).json({
        message: `Almost done — pay ₹${lead.feeAmount} to complete your registration.`,
        requiresPayment: true,
        amount: lead.feeAmount,
      });
    }

    res.status(201).json({
      message: "Registered successfully. You can now log in.",
      requiresPayment: false,
      user: student.toJSON(),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.createLeadPaymentOrder = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "token is required" });

    const lead = await Lead.findOne({ registrationToken: token });
    if (!lead || !lead.convertedStudent) {
      return res.status(404).json({ message: "Invalid registration link" });
    }

    const student = await User.findById(lead.convertedStudent);
    if (!student || !student.paymentPending) {
      return res.status(400).json({ message: "This registration has already been completed" });
    }

    const amountPaise = Math.round(student.balanceDue * 100);
    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `reg_${student._id}`,
      notes: { studentId: String(student._id), leadId: String(lead._id) },
    });

    student.pendingRazorpayOrderId = order.id;
    await student.save();

    res.json({
      orderId: order.id,
      amount: amountPaise,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      name: student.name,
      email: student.email,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || "Could not create payment order" });
  }
};

exports.verifyLeadPayment = async (req, res) => {
  try {
    const { token, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!token || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Missing payment verification fields" });
    }

    const lead = await Lead.findOne({ registrationToken: token });
    if (!lead || !lead.convertedStudent) {
      return res.status(404).json({ message: "Invalid registration link" });
    }
    const student = await User.findById(lead.convertedStudent);
    if (!student || !student.paymentPending) {
      return res.status(400).json({ message: "This registration has already been completed" });
    }

    // Bind verification to the exact order we created for this student —
    // without this check, a valid (order_id, payment_id, signature) triple
    // from ANY successful payment on the merchant account could be replayed
    // to mark an unrelated, possibly higher-fee registration as paid.
    if (!student.pendingRazorpayOrderId || student.pendingRazorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({ message: "Payment verification failed" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const signaturesMatch =
      expectedSignature.length === String(razorpay_signature).length &&
      crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(String(razorpay_signature)));

    if (!signaturesMatch) {
      return res.status(400).json({ message: "Payment verification failed" });
    }

    const paidAmount = student.balanceDue;
    student.isActive = true;
    student.paymentPending = false;
    student.balanceDue = 0;
    student.pendingRazorpayOrderId = null;
    await student.save();

    await Payment.create({
      student: student._id,
      admin: student.admin,
      amount: paidAmount,
      method: "razorpay",
      status: "paid",
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
    });

    res.json({
      message: "Payment verified. Registration complete — you can now log in.",
      user: student.toJSON(),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// --- Paying overdue fees online ---
// Used both by a logged-in student (cookie) and by a student whose account was
// deactivated for unpaid fees (email + password in the body, since they can't
// hold a session). Always pays the full balance due — no payment gateway.
const resolveDuesStudent = async (req) => {
  if (req.user) return req.user;
  const { email, password } = req.body;
  if (!email || !password) return null;
  const user = await User.findOne({ email: String(email).toLowerCase() }).select("+password");
  if (!user || !(await user.comparePassword(password))) return null;
  return user;
};

const duesStudentError = (student) => {
  if (!student || student.role !== "student") return [401, "Invalid credentials"];
  if (student.paymentPending) return [400, "Complete your registration payment from your registration link"];
  if (!student.isActive && !student.deactivatedForPayment) return [403, "Your account is deactivated. Please contact your admin."];
  if (!(student.balanceDue > 0)) return [400, "You have no dues to pay"];
  return null;
};

exports.payDues = async (req, res) => {
  try {
    const student = await resolveDuesStudent(req);
    const bad = duesStudentError(student);
    if (bad) return res.status(bad[0]).json({ message: bad[1] });

    const paidAmount = student.balanceDue;
    if (hasSchedule(student)) {
      // Settles the installments that are due; the next one then becomes current.
      applyPayment(student, paidAmount);
    } else {
      student.balanceDue = 0;
    }
    student.isActive = true;
    student.deactivatedForPayment = false;
    student.deactivationMessage = null;
    if (!hasSchedule(student)) student.paymentGraceUntil = null;
    await student.save();

    await Payment.create({
      student: student._id,
      admin: student.admin,
      amount: paidAmount,
      method: "online",
      status: "paid",
    });
    await closeOutIfFullyPaid(student);

    res.json({ message: "Payment received. Your account is active." });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.logout = (req, res) => {
  res.clearCookie("token", { ...cookieOptions, maxAge: undefined });
  res.json({ message: "Logged out" });
};

exports.me = async (req, res) => {
  const institute = await resolveInstitute(req.user);
  res.json({ user: req.user.toJSON(), institute });
};

// Every role edits their own name/phone/photo here — nothing else. Email,
// password and every institute/role-specific field has its own dedicated
// flow and is deliberately out of scope for this endpoint.
exports.updateMe = async (req, res) => {
  try {
    const user = req.user;
    const { name, phone, removeAvatar } = req.body;

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: "Name cannot be empty" });
      }
      user.name = trimmed;
    }

    if (phone !== undefined) {
      user.phone = String(phone).trim();
    }

    if (req.file) {
      let result;
      try {
        const resourceType = resolveResourceType(req.file.mimetype);
        result = await uploadFile(req.file.path, { folder: `avatars/${user._id}`, resourceType });
      } catch (err) {
        fs.unlink(req.file.path, () => {});
        return res.status(502).json({ message: "Photo upload failed — please try again" });
      }
      fs.unlink(req.file.path, () => {});

      const oldPublicId = user.avatar?.cloudinaryPublicId;
      const oldResourceType = user.avatar?.cloudinaryResourceType;
      user.avatar = { cloudinaryPublicId: result.public_id, cloudinaryResourceType: result.resource_type };
      if (oldPublicId) await deleteFile(oldPublicId, oldResourceType);
    } else if (removeAvatar === "true" || removeAvatar === true) {
      const oldPublicId = user.avatar?.cloudinaryPublicId;
      const oldResourceType = user.avatar?.cloudinaryResourceType;
      user.avatar = { cloudinaryPublicId: null, cloudinaryResourceType: null };
      if (oldPublicId) await deleteFile(oldPublicId, oldResourceType);
    }

    await user.save();
    const institute = await resolveInstitute(user);
    res.json({ user: user.toJSON(), institute });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ message: "Server error" });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) {
      // Same generic response as the "found" paths below, so this endpoint
      // can't be used to check which emails are registered.
      return res.json({
        message: "If an account exists with that email, you'll be able to reset your password shortly.",
      });
    }

    // Admins (and superadmin) always self-serve by email. A student,
    // teacher or telecaller only does when their admin has opted their
    // team into it — otherwise the request just notifies the admin, who
    // sets a new password and hands it to them directly.
    let admin = null;
    if (user.role !== "admin" && user.role !== "superadmin" && user.admin) {
      admin = await User.findById(user.admin).select("name allowSelfPasswordReset");
    }
    const selfServiceAllowed = user.role === "admin" || user.role === "superadmin" || !!admin?.allowSelfPasswordReset;

    if (selfServiceAllowed) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      user.resetPasswordToken = crypto.createHash("sha256").update(rawToken).digest("hex");
      user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_EXPIRE_MS);
      await user.save();

      const frontendOrigin = process.env.FRONTEND_URL || "http://localhost:3000";
      const resetUrl = `${frontendOrigin}/reset-password/${rawToken}`;
      // Sent through the institute's own Gmail sender — themselves for an
      // admin/superadmin, their admin's for everyone else.
      const senderAdminId = user.role === "admin" || user.role === "superadmin" ? user._id : user.admin;
      try {
        await sendPasswordResetEmail(senderAdminId, user.email, resetUrl);
      } catch (err) {
        console.error("[forgot-password] email send failed:", err.message);
      }
      return res.json({ message: "We've sent a password reset link to your email." });
    }

    // Manual flow: notify the admin instead of emailing a reset link.
    if (admin) {
      await Notification.create({
        recipient: admin._id,
        sender: user._id,
        senderRole: user.role,
        sendBatchId: crypto.randomUUID(),
        title: "Password reset requested",
        message: `${user.name} (${user.email}) asked to reset their password. Set a new one for them from ${
          ROLE_LABELS[user.role] || "your team"
        } and share it with them directly.`,
      });
    }
    res.json({
      message: "Your admin has been notified and will help you reset your password — reach out to them directly too.",
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: "token and password are required" });
    }

    const hashedToken = crypto.createHash("sha256").update(String(token)).digest("hex");
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    }).select("+resetPasswordToken +resetPasswordExpires");

    if (!user) {
      return res.status(400).json({ message: "This reset link is invalid or has expired" });
    }

    user.password = password;
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    res.json({ message: "Password reset — you can now log in with your new password." });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
