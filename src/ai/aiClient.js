// aiClient.js
require("dotenv").config();
const OpenAI = require("openai");
const { masterPromptA, phasePromptsRaw } = require("../prompts/promptsIndex");
const { buildCanonicalState } = require("./phaseContract");

const openai = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
});

// 🔹 Load v3 prompts via promptsIndex
const MASTER_PROMPT_V3 = masterPromptA;
const PHASE_PROMPTS_V3 = phasePromptsRaw;

if (!MASTER_PROMPT_V3) {
  console.warn("⚠️ MASTER_PROMPT_V3 is empty. Check promptsIndex.js.");
}
if (!PHASE_PROMPTS_V3) {
  console.warn("⚠️ PHASE_PROMPTS_V3 is empty. Check promptsIndex.js.");
}

// 🔹 Extract intake info from canonical state (single source of truth)
function extractIntakeFromCanonicalState(canonicalState = {}, contact = {}) {
  return {
    languagePreference: canonicalState.languagePreference || contact.languagePreference || null,
    tattooTitle: canonicalState.tattooTitle || null,
    tattooSummary: canonicalState.tattooSummary || null,
    tattooPlacement: canonicalState.tattooPlacement || null,
    tattooStyle: canonicalState.tattooStyle || null,
    sizeOfTattoo: canonicalState.tattooSize || null,
    tattooColorPreference: canonicalState.tattooColorPreference || null,
    howSoonIsClientDeciding: canonicalState.timeline || null,
    firstTattoo: canonicalState.firstTattoo,
    tattooConcerns: canonicalState.tattooConcerns || null,
    tattooPhotoDescription: canonicalState.tattooPhotoDescription || null,
    inquiredTechnician: canonicalState.inquiredTechnician || null,
  };
}


// 🔹 Decide which language to use (en/es)
function detectLanguage(preferred, _tags) {
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
function buildOpenerMessages({
  contact,
  canonicalState,
  intake,
  aiPhase,
  leadTemperature,
  consultExplained,
  latestMessageText,
  contactProfile,
}) {
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
  const language = detectLanguage(
    intake.languagePreference || contactProfile?.languagePreference,
    contactSafe.tags || []
  );

  const userPayload = {
    phase: "opener",              // human-readable phase label
    ai_phase: aiPhase || "intake", // matches what we store in GHL system field
    lead_temperature: leadTemperature,
    language,
    contact: contactSafe,
    canonical_state: canonicalState || {},
    contact_profile: contactProfile || {},
    changed_fields_this_turn: contactProfile?.changedFieldsThisTurn || {},
    intake: intake,
    latest_message_text: latestMessageText || intake?.latestMessageText || null,
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
${MASTER_PROMPT_V3}

---

You are currently in: PHASE = "${aiPhase || 'intake'}".

Use the following Phase Prompts V3 content as reference for behavior, tone, and objectives:
${PHASE_PROMPTS_V3}

**CONVERSATION CONTEXT:**
- This is ${aiPhase === 'intake' ? 'the FIRST message' : 'an ONGOING conversation'}.
- You have access to contactProfile which shows what information you've already collected.
- If contactProfile has fields filled (tattooPlacement, tattooSize, etc.), you've already discussed those topics.
- If you're in "closing" or "qualification" phase, you've likely already explained the consult + deposit process.
- **DO NOT repeat information** that's already in contactProfile or that you've explained in previous messages.
- **DO NOT repeat greetings** - only greet in the very first message of a new conversation.
- Only explicitly acknowledge tattoo details (placement, summary, size, timeline) when changedFieldsThisTurn includes them (you get this as contactProfile.changedFieldsThisTurn AND changed_fields_this_turn in the JSON payload). If changedFieldsThisTurn is empty, do NOT restate existing tattoo details unless the lead explicitly changes them.
- Treat contactProfile and changedFieldsThisTurn as the authoritative memory; do not invent context from conversation history you cannot see.

**CONSULT EXPLANATION RULE (CRITICAL):**
- consultExplained = ${consultExplained ? 'true' : 'false'}
- If consultExplained === true:
  - You may NOT send the full consult + deposit explanation paragraph again.
  - Do NOT explain "15–30 min consult", "refundable deposit", "goes toward your tattoo" etc.
  - Instead, you may only say SHORT references like: "same quick consult we mentioned", "once the deposit's in", "your consult spot".
  - Keep it brief and human — the lead already knows the process.
- If consultExplained === false:
  - You're allowed to explain the consult + deposit once (1–2 bubbles max).
  - After you explain it, the backend will mark consultExplained = true for future messages.

For THIS message:
- If this is the first message (intake phase), generate an opener to start the conversation.
- If this is an ongoing conversation, respond naturally without repeating what you've already said.
- You are the AI "front desk" / setter for a bilingual tattoo studio (English/Spanish).
- If language = "es", reply entirely in Spanish (neutral, non-corporate, no slang, no emojis, no inverted question marks).
- If language = "en", reply in English.

You MUST also maintain and output the "meta" object as described in the AI META FLAGS section of the master prompt:
- Keep aiPhase in sync with where you are in the conversation (intake, discovery, qualification, closing, objections, routing, handoff, reengagement, consult_support).
- Keep leadTemperature consistent with their behavior (hot, warm, cold).
- Set wantsDepositLink and depositPushedThisTurn to true ONLY on turns where you are actively inviting them to move forward with the consult + refundable deposit.
- Set mentionDecoyOffered to true ONLY on turns where you actually offer the lower-priced decoy consult after they resisted the main refundable deposit option.

You will receive the lead's most recent message as "latest_message_text". Use THAT text (plus any relevant past context mentioned in the intake or your own summaries) to:
- Understand what they want (placement, size, style, timing, first tattoo or not, concerns).
- Fill the "field_updates" object with ONLY the information that is clearly stated or strongly implied by their words, following the FIELD UPDATES rules from the master prompt.
- Even on the very first message of the conversation, if they give enough detail (e.g., "half sleeve", "inner forearm", "black and grey", "next month", "first tattoo"), you SHOULD write those into field_updates so the CRM can store them.

You MUST respond with VALID JSON ONLY, no extra text, matching this schema exactly:

{
  "language": "en" | "es",
  "bubbles": [
    "First message bubble as a string",
    "Optional second bubble as a string",
    "Optional third bubble as a string"
  ],
  "internal_notes": "Any internal notes for the human team or later phases (string). If not needed, use an empty string.",
  "meta": {
    "aiPhase": "intake" | "discovery" | "qualification" | "closing" | "objections" | "routing" | "handoff" | "reengagement" | "consult_support",
    "leadTemperature": "hot" | "warm" | "cold",
    "wantsDepositLink": boolean,
    "depositPushedThisTurn": boolean,
    "mentionDecoyOffered": boolean
  },
  "field_updates": {
    "tattoo_placement"?: string,
    "tattoo_size"?: string,
    "tattoo_style"?: string,
    "tattoo_color_preference"?: string,
    "how_soon_is_client_deciding"?: string,
    "first_tattoo"?: boolean,
    "tattoo_concerns"?: string,
    "tattoo_summary"?: string
  }
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
async function generateOpenerForContact({
  contact,
  canonicalState,
  aiPhase,
  leadTemperature,
  latestMessageText,
  contactProfile,
  consultExplained,
}) {
  if (!MASTER_PROMPT_V3) {
    console.warn("⚠️ MASTER_PROMPT_V3 is empty. Check promptsIndex.js.");
  }
  if (!PHASE_PROMPTS_V3) {
    console.warn("⚠️ PHASE_PROMPTS_V3 is empty. Check promptsIndex.js.");
  }

  const canonicalResolved = canonicalState || buildCanonicalState(contact);
  const intake = extractIntakeFromCanonicalState(canonicalResolved, contact);
  // Add latestMessageText to intake if provided
  if (latestMessageText) {
    intake.latestMessageText = latestMessageText;
  }
  const resolvedContactProfile = contactProfile || {};
  const resolvedConsultExplained = consultExplained || false;
  
  const messages = buildOpenerMessages({
    contact,
    canonicalState: canonicalResolved,
    intake,
    aiPhase,
    leadTemperature,
    consultExplained: resolvedConsultExplained,
    latestMessageText,
    contactProfile: resolvedContactProfile,
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

  // Ensure meta exists with defaults
  const meta = parsed.meta || {};
  if (!meta.aiPhase) meta.aiPhase = aiPhase || "intake";
  if (!meta.leadTemperature) meta.leadTemperature = leadTemperature || "warm";
  if (meta.wantsAppointmentOffer === undefined) meta.wantsAppointmentOffer = false;
  parsed.meta = meta;

  // Ensure boolean flags always exist as booleans
  meta.wantsDepositLink =
    typeof meta.wantsDepositLink === "boolean" ? meta.wantsDepositLink : false;
  meta.depositPushedThisTurn =
    typeof meta.depositPushedThisTurn === "boolean"
      ? meta.depositPushedThisTurn
      : false;
  meta.mentionDecoyOffered =
    typeof meta.mentionDecoyOffered === "boolean"
      ? meta.mentionDecoyOffered
      : false;
  meta.wantsAppointmentOffer =
    typeof meta.wantsAppointmentOffer === "boolean"
      ? meta.wantsAppointmentOffer
      : false;
  meta.consultMode = meta.consultMode || "online";

  parsed.meta = meta;

  // Normalize field_updates
  let fieldUpdates = parsed.field_updates;

  if (!fieldUpdates || typeof fieldUpdates !== "object") {
    fieldUpdates = {};
  }

  parsed.field_updates = fieldUpdates;

  // Normalize shape
  if (!Array.isArray(parsed.bubbles)) {
    parsed.bubbles = [String(parsed.bubbles || "")].filter(Boolean);
  }

  return {
    language: parsed.language || detectLanguage(intake.languagePreference),
    bubbles: parsed.bubbles,
    internal_notes: parsed.internal_notes || "",
    meta: parsed.meta,
    field_updates: parsed.field_updates,
  };
}

module.exports = {
  generateOpenerForContact,
};
