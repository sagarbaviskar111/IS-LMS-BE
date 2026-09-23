const Razorpay = require("razorpay");

let client = null;

// Lazily constructed so a missing key pair doesn't crash the whole server —
// it only breaks when a payment endpoint is actually hit.
const getRazorpay = () => {
  if (client) return client;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error("Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Backend/.env");
  }
  client = new Razorpay({ key_id, key_secret });
  return client;
};

module.exports = { getRazorpay };
