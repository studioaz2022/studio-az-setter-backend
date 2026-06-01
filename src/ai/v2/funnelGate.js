// funnelGate.js — funnel_status routing for the v2 AI setter (Phase 0.5)
//
// Pure decision function. Given a contact's current funnel_status and the inbound
// context, it decides what SHOULD happen and returns a structured decision plus the
// custom-field mutations that live mode would apply. It does NOT mutate anything —
// the caller (webhook) decides whether to apply `proposed`. In shadow mode the caller
// just logs the decision and changes nothing.
//
// Decision flow (mirrors AI_SETTER_REWRITE_PLAN.md):
//   funnel_status = active        → proceed (full v2 controller)
//   funnel_status = paused_human  → silent  (decay/resume handled in Phase 4)
//   funnel_status = paused_manual → silent
//   funnel_status = not_a_lead    → silent
//   funnel_status = completed     → reclassify (may flip back to active)
//   funnel_status = unset         → run classifier, then:
//        is_lead && high   → enroll_engage         (bot replies)
//        is_lead && medium → enroll_engage_notify  (bot replies + iOS heads-up)
//        low OR not a lead → mark_not_a_lead        (silent, logged)

const { SYSTEM_FIELDS, FUNNEL_STATUSES } = require("../../config/constants");
const { classifyLead } = require("./classifier");

// Decision actions (what the caller should do).
const ACTIONS = {
  PROCEED: "proceed", // hand off to the v2 conversational controller
  ENROLL_ENGAGE: "enroll_engage", // new lead, high confidence — engage
  ENROLL_ENGAGE_NOTIFY: "enroll_engage_notify", // new lead, medium — engage + notify human
  MARK_NOT_A_LEAD: "mark_not_a_lead", // classifier said no / low conf — silent
  SILENT: "silent", // paused or not-a-lead — do nothing
  RECLASSIFY: "reclassify", // completed contact re-engaged — handled like unset after classify
};

function nowIso() {
  return new Date().toISOString();
}

/** Read the current funnel_status off a contact (null if unset/empty). */
function readFunnelStatus(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  const v = cf[SYSTEM_FIELDS.FUNNEL_STATUS];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Build the decision for a brand-new (or re-classifying) contact from a classifier result. */
function decideFromClassifier(classifierResult, { entrySource, isReclassify }) {
  const { is_tattoo_lead, confidence, language } = classifierResult;

  // Low confidence OR not a lead → not_a_lead (plan rule).
  if (!is_tattoo_lead || confidence === "low") {
    return {
      action: ACTIONS.MARK_NOT_A_LEAD,
      reason: is_tattoo_lead
        ? "classified as lead but low confidence"
        : "classified as not a tattoo lead",
      proposed: { [SYSTEM_FIELDS.FUNNEL_STATUS]: FUNNEL_STATUSES.NOT_A_LEAD },
    };
  }

  // is_lead && (high|medium) → enroll. Medium also pings a human.
  const action = confidence === "high" ? ACTIONS.ENROLL_ENGAGE : ACTIONS.ENROLL_ENGAGE_NOTIFY;
  const proposed = {
    [SYSTEM_FIELDS.FUNNEL_STATUS]: FUNNEL_STATUSES.ACTIVE,
    [SYSTEM_FIELDS.FUNNEL_ENTRY_SOURCE]: entrySource || "unknown",
    [SYSTEM_FIELDS.FUNNEL_ENTRY_DATE]: nowIso(),
  };
  if (SYSTEM_FIELDS.LANGUAGE_PREFERENCE && language) {
    proposed[SYSTEM_FIELDS.LANGUAGE_PREFERENCE] = language;
  }
  return {
    action,
    reason: `${isReclassify ? "re-classified" : "new lead"}: tattoo lead, ${confidence} confidence`,
    proposed,
    notifyHuman: action === ACTIONS.ENROLL_ENGAGE_NOTIFY,
  };
}

/**
 * Route an inbound message through the funnel gate.
 *
 * @param {object} args
 * @param {object} args.contact GHL contact (carries funnel_status custom field)
 * @param {string[]} [args.messages] lead's recent inbound messages (for classifier)
 * @param {object} [args.formData] consultation-form data, if any (for classifier)
 * @param {string} [args.entrySource] website_form | sms | dm | unknown
 * @returns {Promise<{action:string, funnelStatus:string|null, ranClassifier:boolean,
 *                    classifierResult:object|null, reason:string, proposed:object,
 *                    notifyHuman?:boolean}>}
 */
async function routeInbound({ contact, messages = [], formData = null, entrySource = "unknown" } = {}) {
  const funnelStatus = readFunnelStatus(contact);
  const base = { funnelStatus, ranClassifier: false, classifierResult: null, proposed: {} };

  switch (funnelStatus) {
    case FUNNEL_STATUSES.ACTIVE:
      return { ...base, action: ACTIONS.PROCEED, reason: "active funnel member" };

    case FUNNEL_STATUSES.PAUSED_HUMAN:
      return { ...base, action: ACTIONS.SILENT, reason: "paused_human (decay/resume handled in Phase 4)" };

    case FUNNEL_STATUSES.PAUSED_MANUAL:
      return { ...base, action: ACTIONS.SILENT, reason: "paused_manual (manual hold)" };

    case FUNNEL_STATUSES.NOT_A_LEAD:
      return { ...base, action: ACTIONS.SILENT, reason: "not_a_lead (already classified out)" };

    case FUNNEL_STATUSES.COMPLETED: {
      // Re-engaging completed customer — re-run classifier; may flip back to active.
      const classifierResult = await classifyLead({ messages, formData });
      const decision = decideFromClassifier(classifierResult, { entrySource, isReclassify: true });
      // A "not a lead" re-classification should leave them completed, not flip to not_a_lead.
      if (decision.action === ACTIONS.MARK_NOT_A_LEAD) {
        return {
          ...base,
          action: ACTIONS.SILENT,
          ranClassifier: true,
          classifierResult,
          reason: "completed contact re-engaged but not a new tattoo lead — stay completed",
          proposed: {},
        };
      }
      return { ...base, ...decision, ranClassifier: true, classifierResult, funnelStatus };
    }

    default: {
      // Unset (or unrecognized) → brand-new contact → classify.
      const classifierResult = await classifyLead({ messages, formData });
      const decision = decideFromClassifier(classifierResult, { entrySource, isReclassify: false });
      return { ...base, ...decision, ranClassifier: true, classifierResult };
    }
  }
}

module.exports = { routeInbound, readFunnelStatus, decideFromClassifier, ACTIONS };
