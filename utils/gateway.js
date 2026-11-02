const crypto = require("crypto");
const Razorpay = require("razorpay");
const User = require("../models/User");
const Payment = require("../models/Payment");
const { decrypt } = require("./crypto");

// Online payments go through the INSTITUTE's own Razorpay account: each admin
// saves their key pair in Settings, and every order / verification below uses
// the keys of the institute the money is for. There are no shared platform keys.

const NO_GATEWAY_MESSAGE = "Online payment isn't set up for this institute yet. Please contact your institute.";
const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{6,}$/;

const clientFor = (keyId, keySecret) => new Razorpay({ key_id: keyId, key_secret: keySecret });

// The institute's gateway, or null when it hasn't connected Razorpay.
const getGateway = async (adminId) => {
  if (!adminId) return null;
  const admin = await User.findById(adminId).select("razorpay.keyId +razorpay.keySecret");
  const keyId = admin?.razorpay?.keyId;
  const encrypted = admin?.razorpay?.keySecret;
  if (!keyId || !encrypted) return null;
  let secret;
  try {
    secret = decrypt(encrypted);
  } catch {
    return null;
  }
  return { keyId, secret, client: clientFor(keyId, secret) };
};

// How a payment for this institute is handled:
//   gateway - real Razorpay checkout (the institute connected its keys)
//   dev     - no keys, but this is a development machine: record it directly so
//             the flows can be tried without money
//   none    - production without keys: online payment is not available
const paymentMode = async (adminId) => {
  const gateway = await getGateway(adminId);
  if (gateway) return { mode: "gateway", gateway };
  return { mode: process.env.NODE_ENV === "development" ? "dev" : "none" };
};

const toPaise = (amount) => Math.round(Number(amount) * 100);

const createOrder = async (gateway, { amount, receipt, notes }) => {
  const order = await gateway.client.orders.create({
    amount: toPaise(amount),
    currency: "INR",
    receipt: String(receipt).slice(0, 40),
    notes,
  });
  return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: gateway.keyId };
};

// Returns an error message, or null when the payment is genuine. Checks, in
// order: the signature Razorpay produced with THIS institute's secret, that the
// payment id wasn't used before, that the order is for exactly the amount and
// purpose we expect (so a payment for something cheaper can't be replayed), and
// that the money was actually captured.
const verifyPayment = async (gateway, { orderId, paymentId, signature, amount, notes }) => {
  if (!orderId || !paymentId || !signature) return "Payment details are missing — please try again";

  const expected = crypto.createHmac("sha256", gateway.secret).update(`${orderId}|${paymentId}`).digest("hex");
  const given = String(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
    return "Payment verification failed";
  }
  if (await Payment.exists({ razorpayPaymentId: paymentId })) return "This payment has already been used";

  try {
    const order = await gateway.client.orders.fetch(orderId);
    if (order.amount !== toPaise(amount)) return "Payment amount does not match";
    for (const [key, value] of Object.entries(notes || {})) {
      if (String(order.notes?.[key]) !== String(value)) return "Payment verification failed";
    }
    let payment = await gateway.client.payments.fetch(paymentId);
    if (payment.order_id !== orderId) return "Payment verification failed";
    if (payment.status === "authorized") payment = await gateway.client.payments.capture(paymentId, order.amount, "INR");
    if (payment.status !== "captured") return "Your payment has not been completed";
  } catch {
    return "Could not confirm the payment with Razorpay — if money was deducted it will be refunded";
  }
  return null;
};

// For orders whose browser never reported back: the id of the captured payment
// on this order, or null if it was not paid. An authorized payment is captured.
const fetchCapturedPayment = async (gateway, orderId) => {
  const list = await gateway.client.orders.fetchPayments(orderId);
  for (const p of list.items || []) {
    if (p.status === "captured") return p.id;
    if (p.status === "authorized") {
      const captured = await gateway.client.payments.capture(p.id, p.amount, "INR");
      if (captured.status === "captured") return p.id;
    }
  }
  return null;
};

// Used when an admin saves keys: any authenticated read proves they are valid.
const testKeys = async (keyId, keySecret) => {
  try {
    await clientFor(keyId, keySecret).orders.all({ count: 1 });
    return null;
  } catch (err) {
    if (err?.statusCode === 401) return "Razorpay did not accept these keys. Check the Key ID and Key Secret.";
    return "Could not reach Razorpay to check the keys — try again in a moment.";
  }
};

module.exports = {
  NO_GATEWAY_MESSAGE,
  KEY_ID_PATTERN,
  getGateway,
  paymentMode,
  createOrder,
  verifyPayment,
  fetchCapturedPayment,
  testKeys,
};
