// shadowGate.js — Phase 0.5 shadow-mode runner for the v2 funnel gate.
//
// Runs the v2 location filter + funnel gate ALONGSIDE the live v1 pipeline and logs
// what it WOULD have decided. It changes nothing: no GHL writes, no messages, no
// effect on v1. Its only job is to produce a comparison log so we can validate the
// gate against real traffic for a few days before letting it drive anything.
//
// Gated by env AI_BOT_SHADOW="true" (off by default). Fully isolated: every path is
// wrapped so a failure here can never disturb the live webhook. The caller invokes it
// fire-and-forget (not awaited), so the classifier's LLM call adds no latency to v1.

const { checkLocation } = require("./locationFilter");
const { routeInbound } = require("./funnelGate");
const { recordShadowDecision } = require("./shadowStore");

/** Is shadow mode enabled? */
function isShadowEnabled() {
  return process.env.AI_BOT_SHADOW === "true";
}

/** Best-effort coarse entry source from the webhook payload. */
function deriveEntrySource(payload) {
  const t = (payload?.messageType || payload?.message?.messageType || payload?.type || "")
    .toString()
    .toUpperCase();
  if (t.includes("SMS")) return "sms";
  if (t.includes("FB") || t.includes("IG") || t.includes("DM") || t.includes("INSTAGRAM")) return "dm";
  if (t.includes("WHATSAPP")) return "whatsapp";
  return "unknown";
}

/**
 * Run the shadow funnel gate and log the decision. Never throws.
 *
 * @param {object} args
 * @param {object} args.payload raw GHL webhook payload (for location + entry source)
 * @param {object} args.contact merged GHL contact (carries funnel_status)
 * @param {string} [args.contactId] GHL contact id (for the log row)
 * @param {string} [args.contactName] display name (for the log row)
 * @param {string} [args.messageText] the inbound message text (combined/debounced)
 * @param {object} [args.formData] consultation-form data if present
 * @returns {Promise<object|null>} the decision (also returned for tests), or null
 */
async function runShadow({ payload, contact, contactId, contactName, messageText, formData = null } = {}) {
  if (!isShadowEnabled()) return null;
  try {
    const loc = checkLocation(payload);
    if (!loc.isTattoo) {
      console.log(`🕵️ [SHADOW] location=${loc.reason} → v2 would EXIT (not tattoo). No classify.`);
      await recordShadowDecision({
        contactId, contactName, locationId: loc.locationId, locationReason: loc.reason,
        messageText, shadowStage: "location", action: "exit",
        reason: `location=${loc.reason}`, ranClassifier: false,
      });
      return { stage: "location", decision: "exit", location: loc };
    }

    const messages = messageText && messageText.trim() ? [messageText.trim()] : [];
    const entrySource = deriveEntrySource(payload);
    const decision = await routeInbound({ contact, messages, formData, entrySource });

    const cls = decision.classifierResult
      ? ` | classifier: lead=${decision.classifierResult.is_tattoo_lead} conf=${decision.classifierResult.confidence} lang=${decision.classifierResult.language}`
      : "";
    const proposed = Object.keys(decision.proposed || {}).length
      ? ` | would-set: ${JSON.stringify(decision.proposed)}`
      : "";
    console.log(
      `🕵️ [SHADOW] funnel_status=${decision.funnelStatus || "unset"} → action=${decision.action}` +
        `${decision.notifyHuman ? " (+notify)" : ""} | reason="${decision.reason}"${cls}${proposed}`
    );
    await recordShadowDecision({
      contactId, contactName, locationId: loc.locationId, locationReason: loc.reason,
      entrySource, messageText, shadowStage: "funnel",
      funnelStatusCurrent: decision.funnelStatus, action: decision.action,
      notifyHuman: decision.notifyHuman, reason: decision.reason,
      ranClassifier: decision.ranClassifier, classifier: decision.classifierResult,
      proposed: decision.proposed,
    });
    return { stage: "funnel", decision, location: loc, entrySource };
  } catch (err) {
    // Shadow must never disturb the live flow.
    console.error("🕵️ [SHADOW] error (ignored, v1 unaffected):", err.message || err);
    return null;
  }
}

module.exports = { runShadow, isShadowEnabled, deriveEntrySource };
