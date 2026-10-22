const {
  r2Endpoint,
  verifyConfig,
  saveConfig,
  clearConfig,
  describeStorageError,
} = require("../utils/objectStorage");

const PROVIDERS = ["s3", "r2"];

const publicView = (user) => {
  const s = user.videoStorage || {};
  return {
    flow: user.videoFlow || "youtube",
    provider: s.provider || null,
    accessKeyId: s.accessKeyId || null,
    bucket: s.bucket || null,
    region: s.region || null,
    endpoint: s.endpoint || null,
    verified: !!s.verified,
    verifiedAt: s.verifiedAt || null,
  };
};

exports.getStatus = (req, res) => {
  res.json(publicView(req.user));
};

exports.saveStorage = async (req, res) => {
  if (req.user.videoFlow !== "storage") {
    return res.status(403).json({ message: "Your institute isn't set up for a storage server — ask the platform admin." });
  }

  const { provider, accessKeyId, secretAccessKey, bucket, region, accountId } = req.body;
  if (!PROVIDERS.includes(provider)) {
    return res.status(400).json({ message: "Choose AWS S3 or Cloudflare R2" });
  }
  const config = {
    provider,
    accessKeyId: String(accessKeyId || "").trim(),
    secretAccessKey: String(secretAccessKey || "").trim(),
    bucket: String(bucket || "").trim(),
    region: String(region || "").trim(),
    endpoint: null,
  };
  if (!config.accessKeyId || !config.secretAccessKey || !config.bucket) {
    return res.status(400).json({ message: "Access Key ID, Secret Access Key and bucket name are all required" });
  }
  if (provider === "s3" && !config.region) {
    return res.status(400).json({ message: "Region is required for AWS S3 (e.g. ap-south-1)" });
  }
  if (provider === "r2") {
    const id = String(accountId || "").trim();
    if (!/^[a-f0-9]{32}$/i.test(id)) {
      return res.status(400).json({ message: "Cloudflare Account ID should be 32 letters/numbers — copy it from the R2 overview page" });
    }
    config.endpoint = r2Endpoint(id);
    config.region = "auto";
  }

  try {
    await verifyConfig(config);
  } catch (err) {
    console.error(`[storage-verify] failed for admin ${req.user._id}:`, err?.name || err?.message);
    return res.status(400).json({ message: describeStorageError(err) });
  }

  try {
    await saveConfig(req.user._id, config);
    res.json({ message: "Connected — a test file was written, read and deleted successfully." });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.removeStorage = async (req, res) => {
  try {
    await clearConfig(req.user._id);
    res.json({ message: "Storage server disconnected" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
