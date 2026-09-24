const jwt = require("jsonwebtoken");
const { saveCredentials, getConsentUrl, exchangeCodeAndSave, disconnect } = require("../utils/youtube");

// Short-lived, signed state so the redirect back from Google can't be used
// to connect a channel to an admin who never asked for it.
const STATE_EXPIRE = "10m";

exports.getStatus = async (req, res) => {
  const { connected = false, channelTitle = null, googleClientId = null } = req.user.youtube || {};
  res.json({
    connected,
    channelTitle,
    hasCredentials: !!googleClientId,
    googleClientId,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
  });
};

exports.saveCredentials = async (req, res) => {
  try {
    const { clientId, clientSecret } = req.body;
    if (!clientId || !clientSecret) {
      return res.status(400).json({ message: "clientId and clientSecret are required" });
    }
    await saveCredentials(req.user._id, String(clientId).trim(), String(clientSecret).trim());
    res.json({ message: "Google credentials saved — you can now connect a YouTube account." });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.connect = async (req, res) => {
  // instituteSlug rides along in the signed state so the callback — which
  // Google hits directly, no session cookie guaranteed — knows which
  // /<slug>/dashboard/admin/youtube to bounce the browser back to.
  const state = jwt.sign(
    { adminId: req.user._id.toString(), instituteSlug: req.user.instituteSlug || null },
    process.env.JWT_SECRET,
    { expiresIn: STATE_EXPIRE }
  );
  try {
    const url = await getConsentUrl(req.user._id, state);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ message: err.message || "Could not start the connection" });
  }
};

exports.callback = async (req, res) => {
  const frontendOrigin = process.env.FRONTEND_URL || "http://localhost:3000";
  const genericBase = `${frontendOrigin}/login`;

  const { code, state, error } = req.query;
  if (!state) {
    return res.redirect(genericBase);
  }

  let decoded;
  try {
    decoded = jwt.verify(String(state), process.env.JWT_SECRET);
  } catch {
    return res.redirect(genericBase);
  }

  const frontendBase = decoded.instituteSlug
    ? `${frontendOrigin}/${decoded.instituteSlug}/dashboard/admin/youtube`
    : genericBase;

  if (error) {
    return res.redirect(`${frontendBase}?error=${encodeURIComponent(String(error))}`);
  }
  if (!code) {
    return res.redirect(`${frontendBase}?error=missing_code`);
  }

  try {
    await exchangeCodeAndSave(decoded.adminId, String(code));
    res.redirect(`${frontendBase}?connected=1`);
  } catch (err) {
    res.redirect(`${frontendBase}?error=${encodeURIComponent(err.message || "connect_failed")}`);
  }
};

exports.disconnectAccount = async (req, res) => {
  try {
    await disconnect(req.user._id);
    res.json({ message: "YouTube account disconnected" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
