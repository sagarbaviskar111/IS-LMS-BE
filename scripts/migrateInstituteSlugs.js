require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const { generateUniqueSlug } = require("../utils/slug");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const admins = await User.find({ role: "admin", instituteSlug: { $in: [null, undefined] } });
  for (const admin of admins) {
    admin.instituteSlug = await generateUniqueSlug(admin.name, admin._id);
    await admin.save();
    console.log(`${admin.email} -> ${admin.instituteSlug}`);
  }
  console.log(`Backfilled ${admins.length} admin(s).`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
