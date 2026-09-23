const crypto = require("crypto");

// e.g. "K3F9QX2A" — 8 uppercase base32-ish characters
const generateInviteCode = () => {
  return crypto.randomBytes(6).toString("hex").toUpperCase().slice(0, 8);
};

module.exports = generateInviteCode;
