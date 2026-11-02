// Moves registration documents that still sit on this server's disk
// (uploads/registrations) to private Cloudinary storage, compressed.
// Safe to run again: registrations already moved are skipped, and a local file
// is only deleted after its Cloudinary copy is saved on the registration.
//   node scripts/migrateRegistrationFiles.js              (move, keep local copies)
//   node scripts/migrateRegistrationFiles.js --delete-local  (also remove local files)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const CourseRegistration = require("../models/CourseRegistration");
const { uploadPrivate } = require("../utils/cloudinary");
const { REGISTRATION_UPLOAD_DIR } = require("../utils/upload");

const deleteLocal = process.argv.includes("--delete-local");

const moveFile = async (reg, file, imageFormat) => {
  if (!file || file.cloudinaryPublicId || !file.filename) return { moved: false };
  const full = path.join(REGISTRATION_UPLOAD_DIR, path.basename(file.filename));
  if (!fs.existsSync(full)) return { moved: false, missing: true };
  const up = await uploadPrivate(full, { folder: `registrations/${reg.admin}`, mimetype: file.mimetype, imageFormat });
  file.cloudinaryPublicId = up.cloudinaryPublicId;
  file.cloudinaryResourceType = up.cloudinaryResourceType;
  file.format = up.format;
  file.bytes = up.bytes;
  file.mimetype = up.mimetype;
  return { moved: true, local: full };
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const regs = await CourseRegistration.find({});
  let moved = 0;
  let missing = 0;
  for (const reg of regs) {
    const jobs = [
      ...reg.idProofs.map((f) => [f, "jpg"]),
      [reg.selfie, "jpg"],
      [reg.signature, "png"],
    ];
    const locals = [];
    for (const [file, fmt] of jobs) {
      try {
        const r = await moveFile(reg, file, fmt);
        if (r.moved) {
          moved += 1;
          locals.push(r.local);
        }
        if (r.missing) missing += 1;
      } catch (err) {
        console.error(`${reg._id}: ${err.message}`);
      }
    }
    if (locals.length) {
      await reg.save();
      if (deleteLocal) locals.forEach((p) => fs.unlinkSync(p));
    }
  }
  console.log(`Moved ${moved} file(s). ${missing} were already missing on disk.`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
