const fs = require("fs");
const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const User = require("../models/User");
const { encrypt, decrypt } = require("./crypto");

// AWS S3 and Cloudflare R2 both speak the S3 API, so one client covers both —
// R2 just needs a custom endpoint and the "auto" region.
const PLAYBACK_URL_TTL_SECONDS = 6 * 60 * 60;

const r2Endpoint = (accountId) => `https://${accountId}.r2.cloudflarestorage.com`;

const buildClient = ({ provider, accessKeyId, secretAccessKey, region, endpoint }) =>
  new S3Client({
    region: provider === "r2" ? "auto" : region,
    ...(endpoint ? { endpoint } : {}),
    credentials: { accessKeyId, secretAccessKey },
  });

// Loads an admin's stored config (decrypting the secret) into the shape
// buildClient expects. Returns null when the admin hasn't verified one.
const getAdminStorage = async (adminId) => {
  const admin = await User.findById(adminId).select("+videoStorage.secretAccessKey");
  const cfg = admin?.videoStorage;
  if (!cfg || !cfg.verified || !cfg.secretAccessKey) return null;
  return {
    provider: cfg.provider,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: decrypt(cfg.secretAccessKey),
    bucket: cfg.bucket,
    region: cfg.region,
    endpoint: cfg.endpoint,
  };
};

// Maps the raw SDK failure to something a non-technical admin can act on.
const describeStorageError = (err) => {
  const code = err?.name || err?.Code || err?.code;
  const status = err?.$metadata?.httpStatusCode;
  if (code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch" || code === "InvalidSignatureException") {
    return "The Access Key ID or Secret Access Key is wrong. Re-copy both from your provider's dashboard.";
  }
  if (code === "NoSuchBucket" || status === 404) {
    return "That bucket doesn't exist (or the name/region is wrong). Check the bucket name and region.";
  }
  if (code === "AccessDenied" || code === "Forbidden" || status === 403) {
    return "The keys work but aren't allowed to use this bucket. Give the key read, write and delete permission on this bucket.";
  }
  if (code === "PermanentRedirect" || code === "AuthorizationHeaderMalformed" || status === 301) {
    return "The bucket is in a different region than the one you entered. Check the bucket's region.";
  }
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "TimeoutError") {
    return "Couldn't reach the storage server. Check the region / account ID.";
  }
  return "Couldn't connect to the storage server. Check all the fields and try again.";
};

// Proves the credentials really work for what we need — write, read and
// delete — instead of saving keys that only fail at the first teacher upload.
const verifyConfig = async (config) => {
  const client = buildClient(config);
  const key = `.connection-test/${crypto.randomBytes(6).toString("hex")}.txt`;
  await client.send(
    new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: "ok", ContentType: "text/plain" })
  );
  await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
};

const saveConfig = (adminId, config) =>
  User.findByIdAndUpdate(adminId, {
    "videoStorage.provider": config.provider,
    "videoStorage.accessKeyId": config.accessKeyId,
    "videoStorage.secretAccessKey": encrypt(config.secretAccessKey),
    "videoStorage.bucket": config.bucket,
    "videoStorage.region": config.provider === "r2" ? "auto" : config.region,
    "videoStorage.endpoint": config.endpoint || null,
    "videoStorage.verified": true,
    "videoStorage.verifiedAt": new Date(),
  });

const clearConfig = (adminId) =>
  User.findByIdAndUpdate(adminId, {
    "videoStorage.provider": null,
    "videoStorage.accessKeyId": null,
    "videoStorage.secretAccessKey": null,
    "videoStorage.bucket": null,
    "videoStorage.region": null,
    "videoStorage.endpoint": null,
    "videoStorage.verified": false,
    "videoStorage.verifiedAt": null,
  });

const safeName = (name) => String(name || "video").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);

// Streams a local temp file to the admin's bucket (multipart, so a 1GB
// recording doesn't need to fit in memory).
const uploadVideoToStorage = async (adminId, filePath, { fileName, mimeType }) => {
  const config = await getAdminStorage(adminId);
  if (!config) throw new Error("This institute has not set up a storage server yet");
  const client = buildClient(config);
  const key = `recordings/${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName(fileName)}`;
  await new Upload({
    client,
    params: {
      Bucket: config.bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: mimeType,
    },
  }).done();
  return { key, provider: config.provider };
};

// Attaches a short-lived signed `videoUrl` to each storage-hosted video view
// and strips the raw key. One config lookup per request (all materials in a
// listing share an admin); signing itself is local.
const attachPlaybackUrls = async (adminId, views) => {
  const config = views.some((v) => v.storageKey) ? await getAdminStorage(adminId) : null;
  const client = config ? buildClient(config) : null;
  return Promise.all(
    views.map(async (v) => {
      if (v.storageKey) {
        v.videoUrl =
          client && !v.locked
            ? await getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: v.storageKey }), {
                expiresIn: PLAYBACK_URL_TTL_SECONDS,
              })
            : null;
      }
      delete v.storageKey;
      delete v.storageProvider;
      return v;
    })
  );
};

const deleteStoredVideo = async (adminId, key) => {
  const config = await getAdminStorage(adminId);
  if (!config) return;
  await buildClient(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
};

module.exports = {
  r2Endpoint,
  verifyConfig,
  saveConfig,
  clearConfig,
  describeStorageError,
  uploadVideoToStorage,
  attachPlaybackUrls,
  deleteStoredVideo,
};
