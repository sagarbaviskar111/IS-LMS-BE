const fs = require("fs");
const path = require("path");
const Course = require("../models/Course");
const CourseRegistration = require("../models/CourseRegistration");
const Payment = require("../models/Payment");
const { NO_GATEWAY_MESSAGE, paymentMode } = require("../utils/gateway");
const { openRegistrationOrder, claimRegistrationOrder, markRegistrationFulfilled, respondError } = require("../utils/paymentOrders");
const StudentEnrollment = require("../models/StudentEnrollment");
const User = require("../models/User");
const { Readable } = require("stream");
const { getFileUrl, uploadFile, uploadPrivate, deletePrivate, getPrivateFileUrl } = require("../utils/cloudinary");
const { normalizeEmail, normalizeName, normalizePhone } = require("../utils/validators");
const { REGISTRATION_UPLOAD_DIR } = require("../utils/upload");
const { DAY_MS, round2, buildSchedule, paymentTerms } = require("../utils/coursePayment");
const { buildStudentSchedule, rebaseSchedule, syncFromSchedule, hasSchedule } = require("../utils/installmentSchedule");
const DEFAULT_TERMS = require("../utils/defaultCourseTerms");

const removeFiles = (files) => {
  for (const f of Object.values(files || {}).flat()) {
    fs.unlink(f.path, () => {});
  }
};

// What is saved on the registration for one stored (private Cloudinary) file.
const fileRef = (stored, f, docType = "") => ({
  cloudinaryPublicId: stored.cloudinaryPublicId,
  cloudinaryResourceType: stored.cloudinaryResourceType,
  format: stored.format,
  bytes: stored.bytes,
  mimetype: stored.mimetype,
  originalName: f.originalname,
  docType,
});

// ---- who is this link for? ------------------------------------------------
// Two kinds of link share /<institute-slug>/enroll/<token>:
//   - a course's public link (anyone may register for that course), and
//   - a private link the admin made for one specific student.
// The slug must belong to the course's institute, so a link can't be reused
// under another institute's name.
const resolveLink = async (token, slug) => {
  let course = await Course.findOne({ registrationToken: token });
  let enrollment = null;
  if (!course) {
    enrollment = await StudentEnrollment.findOne({ token });
    if (!enrollment) return { status: 404, message: "This registration link is not valid" };
    if (enrollment.usedAt) return { status: 410, message: "This registration link has already been used" };
    if (enrollment.expiresAt && enrollment.expiresAt < new Date()) {
      return { status: 410, message: "This registration link has expired. Ask your institute for a new one." };
    }
    course = await Course.findById(enrollment.course);
    if (!course) return { status: 404, message: "This course is no longer available" };
  }
  const admin = await User.findById(course.admin).select("name logo instituteSlug");
  if (slug && admin?.instituteSlug && String(slug).toLowerCase() !== admin.instituteSlug) {
    return { status: 404, message: "This registration link is not valid" };
  }
  if (!enrollment && !course.isActive) return { status: 410, message: "Registration for this course is closed" };

  let student = null;
  if (enrollment) {
    student = await User.findById(enrollment.student);
    if (!student) return { status: 404, message: "This registration link is no longer valid" };
    if (student.registrationComplete !== false) {
      return { status: 410, message: "This registration has already been completed — please log in." };
    }
  }
  return { course, admin, enrollment, student };
};

// ---- public -----------------------------------------------------------

// What the registration page shows before the student fills anything in.
exports.getRegistrationInfo = async (req, res) => {
  try {
    const ctx = await resolveLink(req.params.token, req.query.slug);
    if (ctx.status) return res.status(ctx.status).json({ message: ctx.message });
    const { course, admin, enrollment, student } = ctx;
    const pm = await paymentMode(course.admin);

    res.json({
      // gateway = real Razorpay checkout, dev = no keys on a dev machine, none = not available
      paymentMode: pm.mode,
      institute: {
        name: admin?.name || "",
        slug: admin?.instituteSlug || "",
        logoUrl: admin?.logo?.cloudinaryPublicId
          ? getFileUrl(admin.logo.cloudinaryPublicId, admin.logo.cloudinaryResourceType)
          : null,
      },
      // Set only for a link made for one particular student.
      enrollment: enrollment
        ? {
            name: student.name,
            email: student.email,
            phone: student.phone || "",
            // Fees already collected by the admin → the student skips the payment step.
            skipPayment: enrollment.paidStatus !== "unpaid",
            plan: enrollment.plan,
            amountPaid: enrollment.amountPaid,
            planTotal: enrollment.planTotal,
            paymentMethod: enrollment.paymentMethod,
            expiresAt: enrollment.expiresAt,
          }
        : null,
      course: {
        name: course.name,
        description: course.description,
        level: course.level,
        language: course.language,
        mode: course.mode,
        durationValue: course.durationValue,
        durationUnit: course.durationUnit,
        prerequisites: course.prerequisites,
        syllabus: course.syllabus,
        oneTimeEnabled: course.oneTimeEnabled,
        oneTimeAmount: course.oneTimeAmount,
        installmentEnabled: course.installmentEnabled,
        installmentCharge: course.installmentCharge,
        installments: course.installments,
        terms: course.terms || DEFAULT_TERMS,
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Finishes the registration in one step: stores the verification files and the
// details, creates (or, for a private link, activates) the student account and
// records the payment — unless the admin already collected it. The fee is paid
// through the institute's own Razorpay account and verified here before anything
// is created (see createRegistrationOrder for step one).
exports.submitRegistration = async (req, res) => {
  const files = req.files || {};
  // Documents already sent to Cloudinary by this request; removed again if the
  // registration does not finish, so no orphaned ID proofs are left behind.
  const stored = [];
  const discardStored = () => stored.forEach((s) => deletePrivate(s.cloudinaryPublicId, s.cloudinaryResourceType));
  const fail = (status, message) => {
    removeFiles(files);
    discardStored();
    return res.status(status).json({ message });
  };
  try {
    const ctx = await resolveLink(req.params.token, (req.body || {}).slug);
    if (ctx.status) return fail(ctx.status, ctx.message);
    const { course, enrollment, student: existingStudent } = ctx;

    const b = req.body || {};
    const name = normalizeName(b.name);
    const phone = normalizePhone(b.phone);
    const password = String(b.password || "");
    // A private link is tied to the email the admin entered; it can't be changed here.
    const email = enrollment ? existingStudent.email : normalizeEmail(b.email);
    if (!name) return fail(400, "Enter your full name");
    if (!email) return fail(400, "Enter a valid email address");
    if (!phone) return fail(400, "Enter a valid phone number");
    if (password.length < 6) return fail(400, "Password must be at least 6 characters");

    let dateOfBirth = null;
    if (b.dateOfBirth) {
      dateOfBirth = new Date(b.dateOfBirth);
      if (Number.isNaN(dateOfBirth.getTime()) || dateOfBirth > new Date()) return fail(400, "Enter a valid date of birth");
    }
    const address = String(b.address || "").trim().slice(0, 500);

    const idType1 = String(b.idType1 || "").trim().slice(0, 40);
    const idType2 = String(b.idType2 || "").trim().slice(0, 40);
    if (!files.idProof1?.length || !files.idProof2?.length) return fail(400, "Upload both ID proofs");
    if (!idType1 || !idType2) return fail(400, "Select the document type of both ID proofs");
    if (idType1 === idType2) return fail(400, "The two ID proofs must be different document types");
    if (!files.selfie?.length) return fail(400, "Take a live photo for face verification");
    if (!files.signature?.length) return fail(400, "Add your digital signature");
    if (b.termsAccepted !== "true") return fail(400, "You must accept the terms and conditions");

    // ---- payment ----
    const alreadyPaid = !!enrollment && enrollment.paidStatus !== "unpaid";
    const plan = alreadyPaid ? enrollment.plan : b.plan;
    const schedule = buildSchedule(course, plan);
    if (!schedule) return fail(400, "Choose a valid payment option");
    const planTotal = round2(schedule.reduce((s, i) => s + i.amount, 0));

    // The amount is set by the institute, never by the student: the full fee for
    // a one-time plan, or the first installment (plus any installment charge).
    const amountPaid = alreadyPaid ? enrollment.amountPaid : round2(schedule[0].amount);
    if (!alreadyPaid && !(amountPaid > 0)) return fail(400, "This course has no payable amount yet — contact the institute");

    // The fee is checked BEFORE anything is created: the paid Razorpay order has to
    // match this course, plan, email and the exact amount set by the institute.
    let paidOrder = null;
    if (!alreadyPaid) {
      const pm = await paymentMode(course.admin);
      if (pm.mode === "none") return fail(400, NO_GATEWAY_MESSAGE);
      if (pm.mode === "gateway") {
        const claimed = await claimRegistrationOrder({
          course,
          token: req.params.token,
          plan,
          email: enrollment ? "" : email,
          amount: amountPaid,
          proof: { orderId: b.razorpayOrderId, paymentId: b.razorpayPaymentId, signature: b.razorpaySignature },
        });
        if (claimed.error) return fail(400, claimed.error);
        paidOrder = claimed.order;
      }
    }
    const terms = alreadyPaid ? null : paymentTerms(schedule, amountPaid);

    // Store the verification documents (compressed, private) before creating the
    // account. If this fails, nothing exists yet and a payment already made on this
    // link is reused on the next try, so the student is not charged twice.
    const folder = `registrations/${course.admin}`;
    const store = async (f, imageFormat) => {
      const up = await uploadPrivate(f.path, { folder, mimetype: f.mimetype, imageFormat });
      stored.push(up);
      return up;
    };
    let docs;
    try {
      docs = {
        id1: await store(files.idProof1[0]),
        id2: await store(files.idProof2[0]),
        selfie: await store(files.selfie[0]),
        signature: await store(files.signature[0], "png"),
      };
    } catch (err) {
      console.error("[course-registration] document upload failed:", err.message);
      return fail(502, "We could not save your documents right now. Please try again in a minute — a payment you already made will not be charged again.");
    }

    let student;
    if (enrollment) {
      student = await User.findById(existingStudent._id);
      student.name = name;
      student.phone = phone;
      student.password = password; // hashed by the model on save
      student.isActive = true;
      student.registrationComplete = true;
      student.deactivationMessage = null;
      student.deactivatedForPayment = false;
      if (alreadyPaid) {
        // Fees were collected earlier; restart the next-installment clock from joining.
        if (hasSchedule(student)) {
          rebaseSchedule(student);
          syncFromSchedule(student);
        } else if (enrollment.nextDays > 0) {
          student.nextDueDate = new Date(Date.now() + enrollment.nextDays * DAY_MS);
        }
      } else {
        student.installmentAmount = terms.installmentAmount;
        student.balanceDue = terms.balanceDue;
        student.nextDueDate = terms.nextDueDate;
        student.installmentSchedule = buildStudentSchedule(schedule, amountPaid);
        syncFromSchedule(student);
      }
      await student.save();
    } else {
      if (await User.findOne({ email })) return fail(409, "An account with this email already exists — log in instead");
      student = await User.create({
        name,
        email,
        password,
        phone,
        role: "student",
        admin: course.admin,
        course: course._id,
        isActive: true,
        installmentAmount: terms.installmentAmount,
        balanceDue: terms.balanceDue,
        nextDueDate: terms.nextDueDate,
      });
      student.installmentSchedule = buildStudentSchedule(schedule, amountPaid);
      syncFromSchedule(student);
      await student.save();
    }

    if (files.profilePhoto?.length) {
      const photo = files.profilePhoto[0];
      try {
        const up = await uploadFile(photo.path, { folder: `avatars/${student._id}`, resourceType: "image" });
        student.avatar = { cloudinaryPublicId: up.public_id, cloudinaryResourceType: up.resource_type };
        await student.save();
      } catch (err) {
        // Not worth failing a finished registration over — they can set it later in their profile.
        console.error("[course-registration] profile photo upload failed:", err.message);
      }
      fs.unlink(photo.path, () => {});
    }

    if (!alreadyPaid) {
      const payment = await Payment.create({
        student: student._id,
        admin: course.admin,
        amount: amountPaid,
        method: paidOrder ? "razorpay" : "manual",
        status: "paid",
        ...(paidOrder ? { razorpayOrderId: paidOrder.razorpayOrderId, razorpayPaymentId: paidOrder.razorpayPaymentId } : {}),
        note: `Course registration: ${course.name} (${plan === "one_time" ? "one-time" : "installments"})`,
      });
      if (paidOrder) await markRegistrationFulfilled(paidOrder, student, payment);
    }

    await CourseRegistration.create({
      course: course._id,
      admin: course.admin,
      student: student._id,
      name,
      email,
      phone,
      dateOfBirth,
      address,
      idType: idType1,
      idProofs: [fileRef(docs.id1, files.idProof1[0], idType1), fileRef(docs.id2, files.idProof2[0], idType2)],
      selfie: fileRef(docs.selfie, files.selfie[0]),
      signature: fileRef(docs.signature, files.signature[0]),
      termsAcceptedAt: new Date(),
      plan,
      planTotal,
      amountPaid,
    });

    if (enrollment) {
      enrollment.usedAt = new Date();
      await enrollment.save();
    }

    // Everything is in Cloudinary now; the temporary copies are not needed.
    removeFiles(files);

    res.status(201).json({
      message: "Registration complete. You can now log in.",
      amountPaid,
      planTotal,
      balance: round2(planTotal - amountPaid),
      paidEarlier: alreadyPaid,
    });
  } catch (err) {
    removeFiles(files);
    discardStored();
    if (err && err.code === 11000) {
      return res.status(409).json({ message: "An account with this email already exists — log in instead" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

// Step one of paying at the end of registration: an order for the fee on the
// institute's own Razorpay account. The student opens Razorpay checkout with it
// and then submits the form together with the payment proof.
exports.createRegistrationOrder = async (req, res) => {
  try {
    const b = req.body || {};
    const ctx = await resolveLink(req.params.token, b.slug);
    if (ctx.status) return res.status(ctx.status).json({ message: ctx.message });
    const { course, enrollment } = ctx;
    if (enrollment && enrollment.paidStatus !== "unpaid") {
      return res.status(400).json({ message: "Nothing to pay — your fees were already received" });
    }

    const schedule = buildSchedule(course, b.plan);
    if (!schedule) return res.status(400).json({ message: "Choose a valid payment option" });
    const amount = round2(schedule[0].amount);
    if (!(amount > 0)) return res.status(400).json({ message: "This course has no payable amount yet — contact the institute" });

    // Don't take money from someone who can't finish registering.
    const email = enrollment ? "" : normalizeEmail(b.email) || "";
    if (!enrollment && email && (await User.findOne({ email }))) {
      return res.status(409).json({ message: "An account with this email already exists — log in instead" });
    }

    res.json(
      await openRegistrationOrder({
        course,
        token: req.params.token,
        plan: b.plan,
        email,
        amount,
        name: enrollment ? ctx.student.name : normalizeName(b.name),
      })
    );
  } catch (err) {
    respondError(res, err, "Could not start the payment");
  }
};

// ---- admin ------------------------------------------------------------

exports.listCourseRegistrations = async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.id, admin: req.user._id });
    if (!course) return res.status(404).json({ message: "Course not found" });
    const registrations = await CourseRegistration.find({ course: course._id, admin: req.user._id })
      .sort({ createdAt: -1 })
      .limit(500)
      .select("name email phone dateOfBirth address idProofs.docType plan planTotal amountPaid createdAt student");
    res.json({ registrations });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// The registration (documents, signature, photo) of one student, if they have one.
exports.getStudentRegistration = async (req, res) => {
  try {
    const reg = await CourseRegistration.findOne({ student: req.params.studentId, admin: req.user._id })
      .sort({ createdAt: -1 })
      .select("name email phone dateOfBirth address idProofs.docType plan planTotal amountPaid createdAt student course")
      .populate("course", "name");
    res.json({ registration: reg || null });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

// Streams one verification file (id1, id2, selfie, signature) to its admin.
exports.getRegistrationFile = async (req, res) => {
  try {
    const reg = await CourseRegistration.findOne({ _id: req.params.regId, admin: req.user._id });
    if (!reg) return res.status(404).json({ message: "Registration not found" });

    const kind = req.params.kind;
    const file = kind === "id1" ? reg.idProofs[0] : kind === "id2" ? reg.idProofs[1] : kind === "selfie" ? reg.selfie : kind === "signature" ? reg.signature : null;
    if (!file) return res.status(404).json({ message: "File not found" });

    res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
    res.setHeader("Cache-Control", "private, no-store");

    if (file.cloudinaryPublicId) {
      // The signed link is used only here, on the server; the admin never sees it.
      const upstream = await fetch(getPrivateFileUrl(file.cloudinaryPublicId, file.cloudinaryResourceType, file.format));
      if (!upstream.ok || !upstream.body) return res.status(404).json({ message: "File is missing from storage" });
      return Readable.fromWeb(upstream.body).pipe(res);
    }

    // Registrations made before the move to Cloudinary still sit on disk.
    if (!file.filename) return res.status(404).json({ message: "File not found" });
    const full = path.join(REGISTRATION_UPLOAD_DIR, path.basename(file.filename));
    if (!fs.existsSync(full)) return res.status(404).json({ message: "File is missing from storage" });
    res.sendFile(full);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
