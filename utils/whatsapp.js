// Sends a plain-text WhatsApp message through the Meta WhatsApp Cloud API.
// Needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in Backend/.env; without
// them the message is only logged, so dev runs never fail on reminders.
// Optional WHATSAPP_DEFAULT_COUNTRY_CODE (default "91") is prefixed to
// 10-digit numbers.
const normalizePhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  const cc = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "91";
  if (digits.length === 10) return cc + digits;
  return digits.replace(/^0+/, "");
};

const sendWhatsApp = async (phone, text) => {
  const to = normalizePhone(phone);
  if (!to) return { sent: false, reason: "no phone number" };

  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.log(`[whatsapp:dry-run] to ${to}: ${text}`);
    return { sent: false, reason: "WhatsApp is not configured" };
  }

  const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { sent: false, reason: body?.error?.message || `HTTP ${res.status}` };
  }
  return { sent: true };
};

module.exports = { sendWhatsApp };
