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
};
