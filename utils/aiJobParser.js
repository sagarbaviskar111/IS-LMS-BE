// Uses Gemini's free API tier (aistudio.google.com/apikey — no credit card
// needed) to turn a pasted, free-form job post (WhatsApp forward, email,
// job-portal copy-paste, whatever shape) into the structured fields the
// "Post a job" form needs, so an admin can paste one message instead of
// typing each field by hand.
// "-latest" aliases auto-track whichever current model Google points them at,
// so this doesn't go stale the way a pinned dated model does. The lite tier
// also gets a far more generous free daily quota than the flagship "flash"
// models, which cap out at a mere 20 requests/day on the free tier — plenty
// for occasional job-post parsing, not for a full flagship model.
const MODEL = "gemini-flash-lite-latest";

const buildPrompt = (text) => `Extract job posting details from the text below and return ONLY a JSON object with these exact keys: title, company, location, skills, responsibilities, description.
- title: the job role/position name.
- company: the hiring company's name.
- location: city, "Remote", etc — "" if not mentioned.
- skills: the required skills/tech stack/qualifications, as a short comma-separated list (e.g. "React, Node.js, 2+ years experience") — "" if not mentioned.
- responsibilities: the day-to-day responsibilities/duties of the role, as clean plain text (use line breaks between points if there are several) — "" if not mentioned.
- description: a short plain-text overview of the role (what it is, who it's for), using only information present in the text — no markdown formatting.
Do not invent anything not present in the text. Return ONLY the JSON object — no markdown code fences, no other text.

Text:
"""
${text}
"""`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The free tier occasionally answers a healthy request with a transient
// 503 "model overloaded" — worth one quick retry before giving up.
const callGemini = async (apiKey, text, attempt = 1) => {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(text) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    }
  );

  if (res.status === 503 && attempt < 3) {
    await sleep(1500 * attempt);
    return callGemini(apiKey, text, attempt + 1);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini request failed (${res.status}): ${errBody.slice(0, 300)}`);
  }

  return res.json();
};

const parseJobText = async (text) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server");
  }

  const data = await callGemini(apiKey, text);
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini returned no content");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not parse Gemini's response as JSON");
  }

  return {
    title: String(parsed.title || "").trim(),
    company: String(parsed.company || "").trim(),
    location: String(parsed.location || "").trim(),
    skills: String(parsed.skills || "").trim(),
    responsibilities: String(parsed.responsibilities || "").trim(),
    description: String(parsed.description || "").trim(),
  };
};

module.exports = { parseJobText };
