const crypto = require("crypto");

// AES-256-GCM for secrets at rest (YouTube refresh tokens/Client Secrets,
// email sender App Passwords, password-reset tokens' source material, etc).
// Key must be a 32-byte value, given as a 64-char hex string. Falls back to
// the older YT_TOKEN_ENCRYPTION_KEY name so already-encrypted YouTube data
// keeps decrypting without a migration.
const getEncryptionKey = () => {
  const hex = process.env.SECRETS_ENCRYPTION_KEY || process.env.YT_TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
};

const encrypt = (text) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
};

const decrypt = (payload) => {
  const [ivHex, authTagHex, dataHex] = payload.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
};

module.exports = { encrypt, decrypt };
