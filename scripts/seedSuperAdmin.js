require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

const NAME = process.env.SEED_SUPERADMIN_NAME || "Super Admin";
const EMAIL = process.env.SEED_SUPERADMIN_EMAIL || "superadmin@dashboard.com";
const PASSWORD = process.env.SEED_SUPERADMIN_PASSWORD || "SuperAdmin@123";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ role: "superadmin" });
  if (existing) {
    console.log(`Superadmin already exists: ${existing.email}`);
    await mongoose.disconnect();
    return;
  }

  const user = await User.create({
    name: NAME,
    email: EMAIL,
    password: PASSWORD,
    role: "superadmin",
  });

  console.log("Superadmin created:");
  console.log(`  email:    ${user.email}`);
  console.log(`  password: ${PASSWORD}`);
  console.log("Change this password after first login.");

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
