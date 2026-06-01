// controller.js — v2 AI setter conversational orchestrator (Phase 1: talk-only).
//
// Phase 1 scope: take an inbound message + conversation history, ask Haiku 4.5 for a
// reply using the 25-principle system prompt, return the reply. NO tools, NO GHL writes,
// NO funnel/phase mutation yet — those land in Phase 2+. This is "just talking" so we can
// validate the voice against stubbed conversations before giving it hands.
//
// Designed so the webhook can eventually call handleInboundMessage(...) much like the v1
// controller does, but for now it's standalone and script-testable.

const fs = require("fs");
const path = require("path");
const { generateReply, MODELS } = require("./anthropicClient");

// Load the static system prompt once at module init (cached prefix on every call).
const SYSTEM_PROMPT_PATH = path.join(__dirname, "..", "..", "prompts", "v4", "system_prompt.md");
let SYSTEM_PROMPT = "";
try {
  SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
} catch (err) {
  console.error(`❌ [v2 controller] failed to load system prompt at ${SYSTEM_PROMPT_PATH}:`, err.message);
}

/**
 * Build a compact per-contact context block. This is DYNAMIC, so it goes after the
 * cached system-prompt breakpoint (it varies per contact and must not poison the cache).
 * Phase 1 keeps it light; Phase 2 will fold in form data, phase, slots, etc.
 */
function buildContextBlock(contact = {}, extra = {}) {
  const cf = contact?.customField || contact?.customFields || {};
  const lines = ["CONTEXT (current lead — use naturally, don't recite):"];
  const name = `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim();
  if (name) lines.push(`- name: ${name}`);
  const lang = extra.language || cf.language_preference;
  if (lang) lines.push(`- language preference: ${lang}`);
  if (cf.returning_client === "true" || cf.returning_client === true) {
    lines.push(`- returning client: yes${cf.total_tattoos_completed ? ` (${cf.total_tattoos_completed} prior tattoos)` : ""}`);
    if (cf.previous_conversation_summary) lines.push(`- last time: ${cf.previous_conversation_summary}`);
  }
  if (extra.faqMode) lines.push("- deposit already paid → FAQ MODE: be calm/brief, don't push or sell.");
  return lines.length > 1 ? lines.join("\n") : null;
}

/**
 * Normalize conversation history into Anthropic messages. Accepts items shaped as
 * { role: "user"|"assistant", content|text } or { direction: "inbound"|"outbound", text }.
 */
function normalizeHistory(history = []) {
  return (history || [])
    .map((m) => {
      const role =
        m.role === "user" || m.role === "assistant"
          ? m.role
          : m.direction === "outbound"
          ? "assistant"
          : "user";
      const content = (m.content ?? m.text ?? "").toString().trim();
      return content ? { role, content } : null;
    })
    .filter(Boolean);
}

/**
 * Collapse consecutive same-role turns and guarantee the array starts with a user turn
 * and is non-empty (Anthropic requires alternating-ish turns starting with user).
 */
function sanitizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n${m.content}`; // merge consecutive same-role turns
    } else {
      out.push({ ...m });
    }
  }
  while (out.length && out[0].role !== "user") out.shift(); // must start with user
  return out;
}

/**
 * Generate the bot's reply to an inbound message. Talk-only.
 *
 * @param {object} args
 * @param {object} [args.contact] GHL contact (for context block)
 * @param {Array}  [args.history] prior turns (oldest→newest)
 * @param {string} args.latestMessageText the new inbound message
 * @param {string} [args.language] detected language hint ("en"|"es")
 * @param {boolean}[args.faqMode] post-deposit FAQ mode
 * @param {string} [args.model] override model (defaults Haiku 4.5)
 * @returns {Promise<{replyText:string, bubbles:string[], model:string, usage:object, stopReason:string}>}
 */
async function handleInboundMessage({ contact = {}, history = [], latestMessageText, language, faqMode = false, model = MODELS.HAIKU } = {}) {
  if (!SYSTEM_PROMPT) throw new Error("v2 system prompt not loaded");
  if (!latestMessageText || !latestMessageText.trim()) {
    throw new Error("handleInboundMessage requires latestMessageText");
  }

  const messages = sanitizeMessages(
    normalizeHistory(history).concat([{ role: "user", content: latestMessageText.trim() }])
  );
  if (!messages.length) throw new Error("no usable messages after sanitize");

  // System = static cached prompt + dynamic (uncached) context block.
  const contextBlock = buildContextBlock(contact, { language, faqMode });
  const system = [{ text: SYSTEM_PROMPT, cache: true }];
  if (contextBlock) system.push({ text: contextBlock });

  const result = await generateReply({ system, messages, model });

  // Split into bubbles on blank lines (the prompt allows up to ~2 short bubbles).
  const bubbles = result.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);

  return {
    replyText: result.text,
    bubbles: bubbles.length ? bubbles : [result.text],
    model: result.model,
    usage: result.usage,
    stopReason: result.stopReason,
  };
}

module.exports = { handleInboundMessage, buildContextBlock, normalizeHistory, sanitizeMessages, SYSTEM_PROMPT_PATH };
