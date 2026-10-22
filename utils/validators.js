// Shared validators for inquiry-form answers. Each returns the cleaned value,
// or null when the input isn't acceptable. (Mirrored client-side in
// Frontend/src/lib/validate.ts for instant feedback — this copy is the one
// that actually enforces.)

// Indian mobile numbers (with or without +91 / 91 / 0 prefix) come back as the
// plain 10 digits, matching how leads are already stored; any other country's
// number must be written with its +country code and comes back as E.164.
const normalizePhone = (raw) => {
  let s = String(raw ?? "")
    .trim()
    .replace(/[\s\-().]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;

  if (s.startsWith("+")) {
    if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
    if (s.startsWith("+91")) return /^\+91[6-9]\d{9}$/.test(s) ? s.slice(3) : null;
    return s;
  }

  if (!/^\d+$/.test(s)) return null;
  if (s.length === 12 && s.startsWith("91")) s = s.slice(2);
  else if (s.length === 11 && s.startsWith("0")) s = s.slice(1);
  return /^[6-9]\d{9}$/.test(s) ? s : null;
};

const normalizeEmail = (raw) => {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s || s.length > 254 || s.includes("..")) return null;
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s) ? s : null;
};

// Letters (any script), spaces, and . ' - — at least 2 characters.
const normalizeName = (raw) => {
  const s = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return /^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,99}$/u.test(s) ? s : null;
};

// One half of a name (first or last): letters, spaces, . ' - ; a single
// letter is fine (initials like "K" are real last names).
const normalizeNamePart = (raw) => {
  const s = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,49}$/u.test(s) ? s : null;
};

module.exports = { normalizePhone, normalizeEmail, normalizeName, normalizeNamePart };
