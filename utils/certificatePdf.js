// @pdf-lib/fontkit's Indic (Devanagari) shaper needs this global; without it
// Hindi names fall through to empty boxes.
global.regeneratorRuntime = global.regeneratorRuntime || require("regenerator-runtime");

const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const { getFileUrl } = require("./cloudinary");

const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
const PAGE_LONG_SIDE = 842; // A4 landscape width in pt; portrait uses the same long side

const STANDARD = {
  helvetica: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
  times: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  courier: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
};
const DEVANAGARI = /[ऀ-ॿ]/;

// Template images are fetched once per process and kept (small LRU) - a bulk
// run would otherwise re-download the same background for every student.
const imageCache = new Map();
const IMAGE_CACHE_MAX = 12;

const fetchTemplateImage = async (template) => {
  const key = template.image.cloudinaryPublicId;
  if (imageCache.has(key)) return imageCache.get(key);
  const url = getFileUrl(key, template.image.cloudinaryResourceType || "image");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Template image unavailable (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  imageCache.set(key, bytes);
  if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  return bytes;
};

const isPng = (b) => b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const n = m ? parseInt(m[1], 16) : 0x111111;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

const formatDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

// Value shown for each placeholder key. Empty string = nothing is drawn.
const valueFor = (field, values, certificateNo) => {
  switch (field.key) {
    case "student_name":
      return values.student_name || "";
    case "certificate_no":
      return certificateNo || "";
    case "course":
      return values.course || "";
    case "batch":
      return values.batch || "";
    case "grade":
      return values.grade || "";
    case "institute_name":
      return values.institute_name || "";
    case "date":
      return values.date ? formatDate(values.date) : "";
    case "custom":
      return field.text || "";
    default:
      return "";
  }
};

// Fonts are embedded once per output document, lazily.
const makeFontBook = (doc) => {
  doc.registerFontkit(fontkit);
  const cache = new Map();
  const load = async (name, build) => {
    if (!cache.has(name)) cache.set(name, build());
    return cache.get(name);
  };
  const noto = (file) => () => doc.embedFont(fs.readFileSync(path.join(FONT_DIR, file)), { subset: true });
  return {
    async pick(field, text) {
      if (DEVANAGARI.test(text)) return load("deva", noto("NotoSansDevanagari-Regular.ttf"));
      if (field.font === "unicode") {
        return field.bold ? load("noto-b", noto("NotoSans-Bold.ttf")) : load("noto-r", noto("NotoSans-Regular.ttf"));
      }
      const set = STANDARD[field.font] || STANDARD.helvetica;
      // set order: regular, bold, italic, bold-italic
      const which = field.bold && field.italic ? 3 : field.bold ? 1 : field.italic ? 2 : 0;
      const name = set[which];
      return load(name, () => doc.embedFont(StandardFonts[name]));
    },
    // Standard fonts only cover WinAnsi; anything else falls back to Noto Sans.
    async safe(field, text) {
      let font = await this.pick(field, text);
      try {
        font.widthOfTextAtSize(text, 10);
        return font;
      } catch {
        return load("noto-r", noto("NotoSans-Regular.ttf"));
      }
    },
  };
};

// Draws one certificate onto a new page of `doc`.
const drawCertificate = async (doc, fonts, template, imageBytes, { values, certificateNo, verifyUrl }) => {
  const img = isPng(imageBytes) ? await doc.embedPng(imageBytes) : await doc.embedJpg(imageBytes);
  const ratio = template.image.width / template.image.height;
  const W = ratio >= 1 ? PAGE_LONG_SIDE : PAGE_LONG_SIDE * ratio;
  const H = ratio >= 1 ? PAGE_LONG_SIDE / ratio : PAGE_LONG_SIDE;
  const page = doc.addPage([W, H]);
  page.drawImage(img, { x: 0, y: 0, width: W, height: H });

  for (const field of template.fields) {
    let text = String(valueFor(field, values, certificateNo)).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (field.transform === "upper") text = text.toUpperCase();
    else if (field.transform === "title") text = titleCase(text);

    let size = (field.fontSize / 100) * W;
    const font = await fonts.safe(field, text);
    let width = font.widthOfTextAtSize(text, size);
    const limit = field.maxWidth > 0 ? (field.maxWidth / 100) * W : 0;
    if (limit && width > limit) {
      size = size * (limit / width);
      width = limit;
    }
    const ax = (field.x / 100) * W;
    const x = field.align === "left" ? ax : field.align === "right" ? ax - width : ax - width / 2;
    // y is the vertical centre of the text line.
    const cy = H - (field.y / 100) * H;
    const y = cy - font.heightAtSize(size, { descender: false }) / 2;
    page.drawText(text, { x, y, size, font, color: hexToRgb(field.color) });
  }

  if (template.qr?.enabled && verifyUrl) {
    const png = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 400, errorCorrectionLevel: "M" });
    const qrImg = await doc.embedPng(png);
    const side = (template.qr.size / 100) * W;
    page.drawImage(qrImg, {
      x: (template.qr.x / 100) * W - side / 2,
      y: H - (template.qr.y / 100) * H - side / 2,
      width: side,
      height: side,
    });
  }
};

// items: [{ template, values, certificateNo, verifyUrl }] -> one PDF, one page each.
const buildPdf = async (items) => {
  const doc = await PDFDocument.create();
  const fonts = makeFontBook(doc);
  for (const item of items) {
    const bytes = await fetchTemplateImage(item.template);
    await drawCertificate(doc, fonts, item.template, bytes, item);
  }
  return Buffer.from(await doc.save());
};

module.exports = { buildPdf, fetchTemplateImage };
