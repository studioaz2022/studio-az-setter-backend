// pipeline.js — full v2 inbound orchestration (Phase 5).
//
// Assembles every v2 piece into one entry point the webhook calls when a contact is on v2:
//
//   location filter → human back-off (A/B/C) → funnel gate → controller (tools) → send → persist
//
// SAFETY: this whole function is wrapped so it NEVER throws — a v2 failure must never break the
// live webhook. The webhook only calls it when resolveBotVersion(contact)==="v2" (default is v1,
// so this path is dormant until a contact is explicitly opted in). dryRun assembles the flow
// without sending messages or writing to GHL.

const { checkLocation } = require("./locationFilter");
const { evaluateBackoff } = require("./humanDetection");
const { smartResumeCheck, pushResumeApproval } = require("./resumeNotifier");
const { routeInbound, ACTIONS } = require("./funnelGate");
const { handleInboundMessage } = require("./controller");
const { sendConversationMessage, updateContact } = require("../../clients/ghlClient");
const { SYSTEM_FIELDS, FUNNEL_STATUSES } = require("../../config/constants");

/** Map raw GHL messages → controller history ({role, content}), excluding the latest inbound. */
function toHistory(rawMessages = []) {
  return (rawMessages || [])
    .map((m) => ({
      role: m.direction === "outbound" ? "assistant" : "user",
      content: (m.body || m.content || m.text || "").toString().trim(),
    }))
    .filter((m) => m.content);
}

function deriveEntrySource(payload) {
  const t = (payload?.messageType || payload?.message?.messageType || payload?.type || "").toString().toUpperCase();
  if (t.includes("SMS")) return "sms";
  if (t.includes("FB") || t.includes("IG") || t.includes("DM") || t.includes("INSTAGRAM")) return "dm";
  if (t.includes("WHATSAPP")) return "whatsapp";
  return "unknown";
}

/**
 * Run the full v2 inbound flow for one message. Never throws.
 * @param {object} args
 * @param {object} args.payload raw webhook payload
 * @param {object} args.contact merged GHL contact
 * @param {string} args.contactId
 * @param {string} [args.contactName]
 * @param {string} args.messageText latest inbound (combined/debounced)
 * @param {Array}  [args.rawMessages] recent GHL messages (for human detection + history)
 * @param {object} [args.channelContext]
 * @param {string} [args.language]
 * @param {boolean}[args.dryRun] assemble without sending/writing
 * @returns {Promise<{action:string, [key:string]:any}>}
 */
async function runV2Inbound({ payload, contact = {}, contactId, contactName, messageText, rawMessages = [], channelContext, language, dryRun = false } = {}) {
  const cf = contact?.customField || contact?.customFields || {};
  const persist = async (fields) => {
    if (dryRun || !contactId) return;
    try { await updateContact(contactId, { customField: fields }); }
    catch (err) { console.error("[v2 pipeline] persist failed:", err.message); }
  };

  try {
    // 1. Location gate.
    const loc = checkLocation(payload);
    if (!loc.isTattoo) return { action: "exit_location", reason: loc.reason };

    // 1b. Manual pause takes precedence over everything. Check it BEFORE the back-off so a
    // human reply in a manually-paused thread can't downgrade paused_manual → paused_human
    // (which would auto-resume after 24h). paused_manual stays off until explicitly resumed.
    const currentStatus = cf[SYSTEM_FIELDS.FUNNEL_STATUS];
    if (currentStatus === FUNNEL_STATUSES.PAUSED_MANUAL) {
      return { action: "silent", reason: "paused_manual (manual hold — no auto-resume)" };
    }

    // 2. Human back-off (Signals A/B/C).
    const backoff = evaluateBackoff({ messages: rawMessages });
    if (backoff.decision === "stay_silent") {
      await persist({
        [SYSTEM_FIELDS.FUNNEL_STATUS]: FUNNEL_STATUSES.PAUSED_HUMAN,
        [SYSTEM_FIELDS.HUMAN_LAST_MESSAGE_AT]: backoff.lastHumanMessageAt || "",
      });
      return { action: "stay_silent", reason: "human in thread, within decay" };
    }
    if (backoff.decision === "check_resume") {
      const resume = await smartResumeCheck(rawMessages);
      if (!resume.open) return { action: "resume_skipped", reason: resume.reasoning };
      // Open → notify for approval, then proceed to draft/send (default-send after window).
      if (!dryRun) pushResumeApproval({ contactId, contactName, draftMessage: "(resuming)" }).catch(() => {});
    }

    // 3. Funnel gate.
    const gate = await routeInbound({
      contact,
      messages: [messageText],
      entrySource: deriveEntrySource(payload),
    });
    if (gate.action === ACTIONS.SILENT || gate.action === ACTIONS.MARK_NOT_A_LEAD) {
      await persist(gate.proposed);
      return { action: gate.action, reason: gate.reason, classifier: gate.classifierResult };
    }

    // 4. Conversational controller (tools enabled).
    const faqMode = String(cf[SYSTEM_FIELDS.DEPOSIT_PAID]) === "true";
    const result = await handleInboundMessage({
      contact,
      contactId,
      contactName,
      channelContext,
      history: toHistory(rawMessages),
      latestMessageText: messageText,
      language: language || cf[SYSTEM_FIELDS.LANGUAGE_PREFERENCE],
      faqMode,
      dryRun,
    });

    // 5. Send the reply (one message per bubble).
    if (!dryRun) {
      for (const bubble of result.bubbles) {
        try { await sendConversationMessage({ contactId, body: bubble, channelContext }); }
        catch (err) { console.error("[v2 pipeline] send failed:", err.message); }
      }
    }

    // 6. Persist funnel state from the gate (active + entry fields, etc.).
    if (gate.proposed && Object.keys(gate.proposed).length) await persist(gate.proposed);

    return {
      action: "replied",
      gateAction: gate.action,
      bubbles: result.bubbles,
      model: result.model,
      escalation: result.escalation,
      toolTrace: result.toolTrace,
      classifier: gate.classifierResult,
    };
  } catch (err) {
    console.error("[v2 pipeline] FATAL (isolated, v1 unaffected):", err.message || err);
    return { action: "error", error: err.message || String(err) };
  }
}

module.exports = { runV2Inbound, toHistory };
