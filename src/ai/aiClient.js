// aiClient.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
});

// 🔹 Helper to load prompt files safely
function loadPrompt(filename) {
  const fullPath = path.join(__dirname, "..", "prompts", filename);
  try {
    const text = fs.readFileSync(fullPath, "utf8");
    console.log(`✅ Loaded prompt file: ${filename}`);
    return text;
  } catch (err) {
    console.error(`❌ Could not load prompt file: ${filename}`, err.message);
    return "";
  }
}

const MASTER_PROMPT_A = loadPrompt("master_system_prompt_a.txt");
const PHASE_PROMPTS_B = loadPrompt("phase_prompts_b.txt");

// 🔹 Extract intake info from a GHL contact
function extractIntakeFromContact(contact) {
  const cfRaw = contact.customField || contact.customFields || {};

  // If GHL returns an array for customField, normalize to an object
  let cf = {};
  if (Array.isArray(cfRaw)) {
    for (const entry of cfRaw) {
      if (!entry) continue;
      const key = entry.key || entry.id || entry.customFieldId;
      if (key) {
        cf[key] = entry.value;
      }
    }
  } else {
    cf = cfRaw;
  }

  // 🔸 Try direct keys first
  let languagePreference =
    cf["language_preference"] ||
    cf["Language Preference"] ||
    cf["languagePreference"] ||
    null;

  // 🔸 Fallback: scan ALL custom fields for a value that looks like a language
  if (!languagePreference) {
    for (const [key, value] of Object.entries(cf)) {
      if (typeof value !== "string") continue;
      const v = value.trim().toLowerCase();
      if (
        v === "spanish" ||
        v === "español" ||
        v === "english" ||
        v === "inglés" ||
        v === "es" ||
        v === "en"
      ) {
        languagePreference = value;
        break;
      }
    }
  }

  const tattooTitle =
    cf["tattoo_title"] ||
    cf["Tattoo Title"] ||
    null;

  const tattooSummary =
    cf["tattoo_summary"] ||
    cf["Tattoo Summary"] ||
    null;

  const tattooPlacement =
    cf["tattoo_placement"] ||
    cf["Tattoo Placement"] ||
    null;

  const tattooStyle =
    cf["tattoo_style"] ||
    cf["Tattoo Style"] ||
    null;

  const sizeOfTattoo =
    cf["size_of_tattoo"] ||
    cf["Size Of Tattoo"] ||
    null;

  const tattooColorPreference =
    cf["tattoo_color_preference"] ||
    cf["Tattoo Color Preference"] ||
    null;

  const howSoonIsClientDeciding =
    cf["how_soon_is_client_deciding"] ||
    cf["How Soon Is Client Deciding?"] ||
    null;

  const firstTattoo =
    cf["first_tattoo"] ||
    cf["First Tattoo?"] ||
    null;

  const tattooConcerns =
    cf["tattoo_concerns"] ||
    cf["Tattoo Concerns"] ||
    null;

  const tattooPhotoDescription =
    cf["tattoo_photo_description"] ||
    cf["Tattoo Photo Description"] ||
    null;

  const inquiredTechnician =
    cf["inquired_technician"] ||
    cf["Artist Inquired (Deseado)"] ||
    null;

  return {
    languagePreference,
    tattooTitle,
    tattooSummary,
    tattooPlacement,
    tattooStyle,
    sizeOfTattoo,
    tattooColorPreference,
    howSoonIsClientDeciding,
    firstTattoo,
    tattooConcerns,
    tattooPhotoDescription,
    inquiredTechnician,
  };
}


// 🔹 Decide which language to use (en/es)
function detectLanguage(preferred) {
  if (!preferred) return "en";

  const v = String(preferred).trim().toLowerCase();

  // Treat anything Spanish-like as 'es'
  if (
    v === "es" ||
    v === "spanish" ||
    v === "español" ||
    v.startsWith("es-") ||
    v.startsWith("es_") ||
    v.includes("español") ||
    v.includes("spanish")
  ) {
    return "es";
  }

  // Treat anything English-like as 'en'
  if (
    v === "en" ||
    v === "english" ||
    v === "inglés" ||
    v.startsWith("en-") ||
    v.startsWith("en_") ||
    v.includes("english")
  ) {
    return "en";
  }

  // Default fallback
  return "en";
}



// 🔹 Build messages array for OpenAI (Phase: Opener / intake)
function buildOpenerMessages({ contact, intake, aiPhase, leadTemperature }) {
  // Normalize contact so we never blow up on missing fields
  const contactSafe = {
    id: contact.id || contact._id || null,
    firstName: contact.firstName || contact.first_name || null,
    lastName: contact.lastName || contact.last_name || null,
    phone: contact.phone || null,
    email: contact.email || null,
    tags: contact.tags || [],
  };

  // Decide language for this opener
  const language = detectLanguage(intake.languagePreference, contactSafe.tags || []);

  const userPayload = {
    phase: "opener",              // human-readable phase label
    ai_phase: aiPhase || "intake", // matches what we store in GHL system field
    lead_temperature: leadTemperature,
    language,
    contact: contactSafe,
    intake: intake,
    instructions: {
      goal:
        "Send the first outbound message as the tattoo studio front desk (AI Setter), to acknowledge their request and move them into a real conversation.",
      notes: [
        "Behave like the front desk / setter, not the artist.",
        "Personalize using name, tattoo idea, size, placement, and timeline.",
        "Do NOT give exact price quotes.",
        "If you mention price range, keep it high-level (e.g. based on size/detail).",
        "Sound human, conversational, and on-brand for Studio AZ.",
        "If language = 'es', use neutral, friendly Spanish without slang and WITHOUT inverted question marks.",
      ],
    },
  };

  const systemContent = `
${MASTER_PROMPT_A}

---

You are currently in: PHASE = "Opener" (ai_phase = "${aiPhase}") for a NEW INTAKE.

Use the following Phase B prompt content as reference for behavior, tone, and objectives:
${PHASE_PROMPTS_B}

For THIS call:
- Only generate the FIRST outbound message (or up to 2–3 short bubbles) to start the conversation.
- Do NOT ask for payment or booking yet unless the prompt library explicitly says to in the opener.
- You are the AI "front desk" / setter for a bilingual tattoo studio (English/Spanish).
- If language = "es", reply entirely in Spanish (neutral, non-corporate, no slang, no emojis, no inverted question marks).
- If language = "en", reply in English.

You MUST respond with VALID JSON ONLY, no extra text, matching this schema exactly:

{
  "language": "en" | "es",
  "bubbles": [
    "First message bubble as a string",
    "Optional second bubble as a string",
    "Optional third bubble as a string"
  ],
  "internal_notes": "Any internal notes for the human team or later phases (string). If not needed, use an empty string."
}
`;

  return [
    {
      role: "system",
      content: systemContent,
    },
    {
      role: "user",
      content: JSON.stringify(userPayload, null, 2),
    },
  ];
}




// 🔹 Main: generate opener for a new intake (form webhook)
async function generateOpenerForContact({ contact, aiPhase, leadTemperature }) {
  if (!MASTER_PROMPT_A) {
    console.warn("⚠️ MASTER_PROMPT_A is empty. Check prompt file path.");
  }
  if (!PHASE_PROMPTS_B) {
    console.warn("⚠️ PHASE_PROMPTS_B is empty. Check prompt file path.");
  }

  const intake = extractIntakeFromContact(contact);
  const messages = buildOpenerMessages({
    contact,
    intake,
    aiPhase,
    leadTemperature,
  });

  console.log("🤖 Calling OpenAI for opener with payload summary:", {
    contactId: contact.id || contact._id,
    leadTemperature,
    aiPhase,
    language: detectLanguage(intake.languagePreference, contact.tags || []),
  });


  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages,
    temperature: 0.4,
  });

  const rawText = completion.choices?.[0]?.message?.content || "";
  console.log("🤖 Raw OpenAI opener response:", rawText);

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    console.error("❌ Failed to parse OpenAI opener JSON, returning fallback.", err.message);
    // Fallback: wrap the raw text into a single bubble
    parsed = {
      language: detectLanguage(intake.languagePreference),
      bubbles: [rawText],
      internal_notes: "OpenAI returned non-JSON; raw text wrapped as single bubble.",
    };
  }

  // Normalize shape
  if (!Array.isArray(parsed.bubbles)) {
    parsed.bubbles = [String(parsed.bubbles || "")].filter(Boolean);
  }

  return {
    language: parsed.language || detectLanguage(intake.languagePreference),
    bubbles: parsed.bubbles,
    internal_notes: parsed.internal_notes || "",
    meta: {
      aiPhase,
      leadTemperature,
    },
  };
}

module.exports = {
  generateOpenerForContact,
};
