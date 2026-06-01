// classifier.js — funnel entry classifier (Phase 0.5)
//
// Runs ONLY on a brand-new contact's first inbound (funnel_status unset) or when a
// `completed` contact re-engages. Low-stakes, structured, high-volume — so it uses
// the cheap gpt-4.1-mini hookup that already powers the v1 opener (process.env.LLM_API_KEY).
//
// Output (validated): { is_tattoo_lead, confidence, reasoning, language }
//
// Never throws to the caller. On any error it returns a fail-safe LOW-confidence
// "not a lead" result so the webhook can decide to stay silent rather than crash.

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.LLM_API_KEY });

const MODEL = "gpt-4.1-mini";
const CONFIDENCES = ["high", "medium", "low"];
const LANGUAGES = ["en", "es"];

// Load the prompt once at module init.
const PROMPT_PATH = path.join(__dirname, "..", "..", "prompts", "v4", "classifier_prompt.md");
let SYSTEM_PROMPT = "";
try {
  SYSTEM_PROMPT = fs.readFileSync(PROMPT_PATH, "utf8");
} catch (err) {
  console.error(`❌ [classifier] Failed to load prompt at ${PROMPT_PATH}:`, err.message);
}

/** Fail-safe result: treat as not-a-lead, low confidence. */
function failSafe(reason, language = "en") {
  return {
    is_tattoo_lead: false,
    confidence: "low",
    reasoning: reason,
    language,
    _error: true,
  };
}

/** Coerce an arbitrary parsed object into a valid classifier result. */
function normalize(parsed) {
  const language = LANGUAGES.includes(parsed?.language) ? parsed.language : "en";
  const confidence = CONFIDENCES.includes(parsed?.confidence) ? parsed.confidence : "low";
  const is_tattoo_lead = parsed?.is_tattoo_lead === true;
  const reasoning =
    typeof parsed?.reasoning === "string" && parsed.reasoning.trim()
      ? parsed.reasoning.trim()
      : "(no reasoning returned)";
  return { is_tattoo_lead, confidence, reasoning, language };
}

/**
 * Build the user-message content from the lead's recent messages + optional form data.
 * @param {object} input
 * @param {string[]} [input.messages] lead's first 1-3 inbound messages (oldest→newest)
 * @param {object} [input.formData] consultation-form fields if the lead came from the website
 * @returns {string}
 */
function buildUserContent({ messages = [], formData = null } = {}) {
  const parts = [];
  const cleanMsgs = (messages || []).filter((m) => typeof m === "string" && m.trim());
  if (cleanMsgs.length) {
    parts.push("LEAD MESSAGES (oldest first):");
    cleanMsgs.forEach((m, i) => parts.push(`${i + 1}. ${m.trim()}`));
  } else {
    parts.push("LEAD MESSAGES: (none — form submission only)");
  }
  if (formData && typeof formData === "object" && Object.keys(formData).length) {
    parts.push("\nCONSULTATION FORM DATA:");
    parts.push(JSON.stringify(formData, null, 2));
  } else {
    parts.push("\nCONSULTATION FORM DATA: (none)");
  }
  return parts.join("\n");
}

/**
 * Classify an inbound contact as a tattoo lead or not.
 * @param {object} input see buildUserContent
 * @returns {Promise<{is_tattoo_lead:boolean, confidence:string, reasoning:string, language:string, _error?:boolean}>}
 */
async function classifyLead(input = {}) {
  if (!SYSTEM_PROMPT) return failSafe("classifier prompt failed to load");
  if (!process.env.LLM_API_KEY) return failSafe("LLM_API_KEY not set");

  const userContent = buildUserContent(input);

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("❌ [classifier] non-JSON response:", raw.slice(0, 200));
      return failSafe("classifier returned non-JSON");
    }
    return normalize(parsed);
  } catch (err) {
    console.error("❌ [classifier] API error:", err.message || err);
    return failSafe(`classifier API error: ${err.message || "unknown"}`);
  }
}

module.exports = { classifyLead, buildUserContent, normalize, MODEL };
