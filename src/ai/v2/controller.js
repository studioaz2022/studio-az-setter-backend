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
const { getActiveToolDefinitions, executeTool } = require("./tools");
const { decideModel } = require("./escalation");
const { recordObjectionEvent } = require("./objectionStore");

const MAX_TOOL_ITERATIONS = 6; // safety cap on the tool-use loop

// Load the static system prompt + objection principles once at module init.
// Both form the cached prefix on every call (together they exceed Haiku's 2048-token
// cache minimum, so caching actually activates from Phase 3 onward).
const PROMPT_DIR = path.join(__dirname, "..", "..", "prompts", "v4");
const SYSTEM_PROMPT_PATH = path.join(PROMPT_DIR, "system_prompt.md");
const OBJECTION_PRINCIPLES_PATH = path.join(PROMPT_DIR, "objection_principles.md");
let SYSTEM_PROMPT = "";
let OBJECTION_PRINCIPLES = "";
try {
  SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
} catch (err) {
  console.error(`❌ [v2 controller] failed to load system prompt at ${SYSTEM_PROMPT_PATH}:`, err.message);
}
try {
  OBJECTION_PRINCIPLES = fs.readFileSync(OBJECTION_PRINCIPLES_PATH, "utf8");
} catch (err) {
  console.error(`❌ [v2 controller] failed to load objection principles at ${OBJECTION_PRINCIPLES_PATH}:`, err.message);
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
 * @param {object} [args.contact] GHL contact (for context block + tool ctx)
 * @param {string} [args.contactId] GHL contact id (required for live tool execution)
 * @param {object} [args.channelContext] channel info for message sending (passed to tool ctx)
 * @param {string} [args.contactName] display name (passed to tool ctx)
 * @param {Array}  [args.history] prior turns (oldest→newest)
 * @param {string} args.latestMessageText the new inbound message
 * @param {string} [args.language] detected language hint ("en"|"es")
 * @param {boolean}[args.faqMode] post-deposit FAQ mode
 * @param {boolean}[args.useTools] enable the tool-use loop (default true)
 * @param {boolean}[args.dryRun] execute tools as no-op mocks (tests; no GHL/Square writes)
 * @param {string} [args.forceModel] pin a specific model (tests); otherwise auto-escalated
 * @returns {Promise<{replyText:string, bubbles:string[], model:string, usage:object, stopReason:string, toolTrace:Array, escalation:object}>}
 */
async function handleInboundMessage({
  contact = {},
  contactId,
  channelContext,
  contactName,
  history = [],
  latestMessageText,
  language,
  faqMode = false,
  useTools = true,
  dryRun = false,
  forceModel = null,
} = {}) {
  if (!SYSTEM_PROMPT) throw new Error("v2 system prompt not loaded");
  if (!latestMessageText || !latestMessageText.trim()) {
    throw new Error("handleInboundMessage requires latestMessageText");
  }

  const normalizedHistory = normalizeHistory(history);
  const messages = sanitizeMessages(
    normalizedHistory.concat([{ role: "user", content: latestMessageText.trim() }])
  );
  if (!messages.length) throw new Error("no usable messages after sanitize");

  // Escalation: hard turns (objection / pushback / circling) go to Sonnet, else Haiku.
  const escalation = decideModel({ latestMessageText, history: normalizedHistory });
  const model = forceModel || escalation.model;

  // System = static cached prefix (system prompt + objection principles) + dynamic
  // (uncached) context block. Cache breakpoint sits on the objection principles so the
  // whole static prefix is cached and the per-contact context after it is not.
  const contextBlock = buildContextBlock(contact, { language, faqMode });
  const system = [{ text: SYSTEM_PROMPT }];
  if (OBJECTION_PRINCIPLES) system.push({ text: OBJECTION_PRINCIPLES, cache: true });
  else system[0].cache = true; // fall back to caching the system prompt alone
  if (contextBlock) system.push({ text: contextBlock });

  const tools = useTools ? getActiveToolDefinitions() : undefined;
  const toolCtx = {
    contactId,
    contact,
    channelContext,
    contactName: contactName || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim() || null,
    language,
    dryRun,
  };

  const toolTrace = [];
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const addUsage = (u = {}) => {
    usageTotals.input_tokens += u.input_tokens || 0;
    usageTotals.output_tokens += u.output_tokens || 0;
    usageTotals.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usageTotals.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  };

  let result;
  // Tool-use loop: keep going while the model asks to call tools.
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    result = await generateReply({ system, messages, tools, model });
    addUsage(result.usage);

    if (result.stopReason !== "tool_use" || !result.toolUses.length) break;

    // Append the assistant's tool-use turn verbatim, then the tool results.
    messages.push({ role: "assistant", content: result.content });
    const toolResults = [];
    for (const call of result.toolUses) {
      const out = await executeTool(call.name, call.input || {}, toolCtx);
      toolTrace.push({ name: call.name, input: call.input, output: out });
      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(out),
      });
    }
    messages.push({ role: "user", content: toolResults });

    if (i === MAX_TOOL_ITERATIONS - 1) {
      console.warn(`⚠️ [v2 controller] hit MAX_TOOL_ITERATIONS for contact ${contactId}`);
    }
  }

  const text = result?.text || "";
  const bubbles = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);

  // Log detected objections for the Phase 6 tuning loop (best-effort; no-op until table exists).
  // Skip in dryRun so tests don't write rows.
  if (escalation.objectionId && !dryRun) {
    recordObjectionEvent({
      contactId,
      contactName: toolCtx.contactName,
      objectionId: escalation.objectionId,
      escalationReason: escalation.reason,
      messageText: latestMessageText,
      botReply: text,
      modelUsed: model,
      language,
    }).catch(() => {});
  }

  return {
    replyText: text,
    bubbles: bubbles.length ? bubbles : (text ? [text] : []),
    model: result?.model || model,
    usage: usageTotals,
    stopReason: result?.stopReason || null,
    toolTrace,
    escalation, // { escalate, model, reason, objectionId }
  };
}

module.exports = { handleInboundMessage, buildContextBlock, normalizeHistory, sanitizeMessages, SYSTEM_PROMPT_PATH };
