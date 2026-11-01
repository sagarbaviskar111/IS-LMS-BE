// Teacher reviews are small rich-text snippets (bold, italics, bullet and
// numbered lists). The editor produces HTML, so everything is run through an
// allowlist here before storing: only the tags below survive, never with
// attributes, and any other "<" or ">" is escaped to text.
const ALLOWED = new Set(["b", "strong", "i", "em", "u", "ul", "ol", "li", "p", "br", "div"]);
const MAX_LEN = 5000;

const escapeText = (s) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

const sanitizeRichText = (input) => {
  if (typeof input !== "string") return "";
  const parts = input.slice(0, MAX_LEN * 2).split(/(<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*)?\/?>)/g);
  let out = "";
  for (const part of parts) {
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s[^<>]*)?(\/?)>$/.exec(part);
    if (!m) {
      out += escapeText(part);
      continue;
    }
    const name = m[2].toLowerCase();
    if (!ALLOWED.has(name)) continue; // drop the tag, keep its text content
    out += name === "br" ? "<br>" : `<${m[1]}${name}>`;
  }
  out = out.trim();
  // An editor with only empty paragraphs / line breaks counts as no review.
  const hasContent = out.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length > 0;
  return hasContent ? out.slice(0, MAX_LEN) : "";
};

module.exports = { sanitizeRichText };
