require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const { generateTenantInviteCodes } = require("../controllers/userController");

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const admins = await User.find({
    role: "admin",
    $or: [
      { studentInviteCode: { $exists: false } },
      { teacherInviteCode: { $exists: false } },
      { telecallerInviteCode: { $exists: false } },
    ],
  });

  for (const admin of admins) {
    const codes = await generateTenantInviteCodes();
    admin.studentInviteCode = codes.studentInviteCode;
    admin.teacherInviteCode = codes.teacherInviteCode;
    admin.telecallerInviteCode = codes.telecallerInviteCode;
    await admin.save();
    console.log(`${admin.email}: student=${codes.studentInviteCode} teacher=${codes.teacherInviteCode} telecaller=${codes.telecallerInviteCode}`);
  }

  // Drop the old single inviteCode field and its index if still present.
  await User.collection.updateMany({ inviteCode: { $exists: true } }, { $unset: { inviteCode: "" } });
  try {
    await User.collection.dropIndex("inviteCode_1");
  } catch {
    // index may not exist — fine
  }

  console.log(`Migrated ${admins.length} admin(s).`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
