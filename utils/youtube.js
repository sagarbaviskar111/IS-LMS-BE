const fs = require("fs");
const { google } = require("googleapis");
const User = require("../models/User");
const { encrypt, decrypt } = require("./crypto");

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

// Each institute brings its own Google Cloud OAuth app — the YouTube Data
// API's upload quota is allocated per project, not per channel, so sharing
// one app across every institute would mean they all draw from the same
// small daily allowance.
const createOAuthClient = (clientId, clientSecret) =>
  new google.auth.OAuth2(clientId, clientSecret, process.env.GOOGLE_REDIRECT_URI);

const saveCredentials = async (adminId, clientId, clientSecret) => {
  await User.findByIdAndUpdate(adminId, {
    "youtube.googleClientId": clientId,
    "youtube.googleClientSecret": encrypt(clientSecret),
    // Changing credentials invalidates any refresh token issued under the
    // old ones — force a fresh connect rather than leave a stale, silently
    // broken "connected" state.
    "youtube.connected": false,
    "youtube.channelId": null,
    "youtube.channelTitle": null,
    "youtube.refreshToken": null,
    "youtube.connectedAt": null,
  });
};

const getOwnCredentials = async (adminId) => {
  const admin = await User.findById(adminId).select("+youtube.googleClientSecret");
  const clientId = admin?.youtube?.googleClientId;
  const encryptedSecret = admin?.youtube?.googleClientSecret;
  if (!clientId || !encryptedSecret) {
    throw new Error("Add this institute's Google Client ID and Client Secret before connecting");
  }
  return { clientId, clientSecret: decrypt(encryptedSecret) };
};

const getConsentUrl = async (adminId, state) => {
  const { clientId, clientSecret } = await getOwnCredentials(adminId);
  const client = createOAuthClient(clientId, clientSecret);
  return client.generateAuthUrl({
    access_type: "offline",
    // Forces Google to always hand back a refresh_token, even on a
    // re-consent from an admin who connected before.
    prompt: "consent",
    scope: SCOPES,
    state,
  });
};

const exchangeCodeAndSave = async (adminId, code) => {
  const { clientId, clientSecret } = await getOwnCredentials(adminId);
  const client = createOAuthClient(clientId, clientSecret);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token — please try connecting again");
  }
  client.setCredentials(tokens);

  const youtube = google.youtube({ version: "v3", auth: client });
  const { data } = await youtube.channels.list({ part: ["snippet"], mine: true });
  const channel = data.items && data.items[0];

  await User.findByIdAndUpdate(adminId, {
    "youtube.connected": true,
    "youtube.channelId": channel ? channel.id : null,
    "youtube.channelTitle": channel ? channel.snippet.title : null,
    "youtube.refreshToken": encrypt(tokens.refresh_token),
    "youtube.connectedAt": new Date(),
  });

  return { channelTitle: channel ? channel.snippet.title : null };
};

const getAuthorizedYoutubeClient = async (adminId) => {
  const admin = await User.findById(adminId).select("+youtube.refreshToken +youtube.googleClientSecret");
  if (!admin || !admin.youtube || !admin.youtube.connected || !admin.youtube.refreshToken) {
    throw new Error("This institute has not connected a YouTube account yet");
  }

  const client = createOAuthClient(admin.youtube.googleClientId, decrypt(admin.youtube.googleClientSecret));
  client.setCredentials({ refresh_token: decrypt(admin.youtube.refreshToken) });
  return google.youtube({ version: "v3", auth: client });
};

// The googleapis client throws a gaxios error whose useful detail lives in
// response.data.error (Google's own JSON body), not in err.message, which is
// usually just a generic "Request failed with status code 403". Pulling the
// real reason out lets us tell "you're out of quota for today" apart from
// "your connection expired" instead of a single opaque failure for both.
const describeYoutubeError = (err) => {
  const status = err?.response?.status || err?.code;
  const googleErrors = err?.response?.data?.error?.errors || [];
  const reasons = googleErrors.map((e) => e.reason);
  const oauthError = err?.response?.data?.error; // string form, e.g. "invalid_grant"

  if (reasons.includes("quotaExceeded") || reasons.includes("dailyLimitExceeded")) {
    return {
      reason: "quotaExceeded",
      message:
        "Your institute's YouTube API quota for today is used up (Google gives a limited number of uploads per day per Google Cloud project). It resets at midnight Pacific Time — try again later, or ask Google for a higher quota from your Google Cloud Console.",
    };
  }
  if (reasons.includes("uploadLimitExceeded")) {
    return {
      reason: "uploadLimitExceeded",
      message:
        "This YouTube channel has hit its own daily upload limit (separate from the API quota). Try again in 24 hours, or verify the channel's phone number on youtube.com to raise this limit.",
    };
  }
  if (status === 401 || oauthError === "invalid_grant" || reasons.includes("authError") || reasons.includes("invalidCredentials")) {
    return {
      reason: "authError",
      message: "Your institute's YouTube connection has expired or was revoked — reconnect it from Settings > YouTube.",
    };
  }

  return { reason: "unknown", message: "Upload to YouTube failed — please try again." };
};

const uploadVideo = async (adminId, filePath, { title, description }) => {
  const youtube = await getAuthorizedYoutubeClient(adminId);
  const { data } = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description: description || "" },
      status: { privacyStatus: "unlisted" },
    },
    media: { body: fs.createReadStream(filePath) },
  });
  return { videoId: data.id };
};

const disconnect = async (adminId) => {
  const admin = await User.findById(adminId).select("+youtube.refreshToken +youtube.googleClientSecret");
  if (admin && admin.youtube && admin.youtube.refreshToken) {
    try {
      const client = createOAuthClient(admin.youtube.googleClientId, decrypt(admin.youtube.googleClientSecret));
      await client.revokeToken(decrypt(admin.youtube.refreshToken));
    } catch (err) {
      // Best-effort — token may already be invalid/expired on Google's side.
    }
  }

  // Only the channel connection — the Google Client ID/Secret this institute
  // set up stay in place, so reconnecting doesn't require re-entering them.
  await User.findByIdAndUpdate(adminId, {
    "youtube.connected": false,
    "youtube.channelId": null,
    "youtube.channelTitle": null,
    "youtube.refreshToken": null,
    "youtube.connectedAt": null,
  });
};

module.exports = {
  saveCredentials,
  getConsentUrl,
  exchangeCodeAndSave,
  uploadVideo,
  disconnect,
  describeYoutubeError,
};
