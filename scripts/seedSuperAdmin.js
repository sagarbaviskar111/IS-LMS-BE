require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

const NAME = process.env.SEED_SUPERADMIN_NAME || "Super Admin";
const EMAIL = process.env.SEED_SUPERADMIN_EMAIL;
const PASSWORD = process.env.SEED_SUPERADMIN_PASSWORD;

const run = async () => {
  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "Set SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD before running this script — no default credentials are provided."
    );
  }

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
