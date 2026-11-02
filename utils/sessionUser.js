const User = require("../models/User");

// The user object the dashboard receives. A sub-admin sees its admin's institute
// (invite codes and branding, so the admin pages work) but its own name, email and
// photo, plus what it is allowed to use.
const sessionUser = async (user) => {
  if (user.role !== "subadmin") return user.toJSON();
  const admin = await User.findById(user.admin);
  const base = admin ? admin.toJSON() : {};
  // Nothing about the admin's money, keys or sender account goes to a helper.
  delete base.emailSender;
  delete base.razorpay;
  delete base.youtube;
  delete base.videoStorage;
  delete base.leadWebhookKey;
  delete base.feeRules;
  const own = user.toJSON();
  return {
    ...base,
    _id: own._id,
    name: own.name,
    email: own.email,
    phone: own.phone,
    avatarUrl: own.avatarUrl,
    role: "admin",
    subadmin: { permissions: own.permissions || {}, adminId: String(user.admin), adminName: base.name || "" },
  };
};

module.exports = { sessionUser };
