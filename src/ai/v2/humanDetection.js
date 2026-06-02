// humanDetection.js — back-off system for the v2 AI setter (Phase 4).
//
// The biggest v1 UX problem: the bot didn't reliably know when a human was talking to the
// lead, or when it was safe to come back. v2 layers three signals:
//
//   Signal A (here): message-log analysis — is a real human (GHL user) in the thread?
//   Signal B (here): 24h auto-extending decay window — clock resets when EITHER side speaks;
//                    the bot only considers resuming after both sides are silent for 24h.
//   Signal C (resumeNotifier.js): a Haiku "is this still open?" check before re-entry.
//
// Discriminating human vs bot outbound (matches existing contextBuilder logic):
//   source "app"               → human (sent from GHL mobile/web app)
//   source "workflow"|"api"    → automation/bot
//   fallback: outbound with a userId that isn't the AI bot's → human
//
// Pure logic; `now` is injectable so the decay math is unit-testable.

// The AI bot's GHL user id (mirrors ghlClient.AI_BOT_USER_ID). Outbound from any other user = human.
const AI_BOT_USER_ID = "3dsbsgZpCWrDYCFPvhKu";
const DECAY_HOURS = 24;
const DECAY_MS = DECAY_HOURS * 3600 * 1000;

/** Is this message an outbound sent by a real human (not the bot/automation)? */
function isHumanMessage(m) {
  if (!m || m.direction !== "outbound") return false;
  const source = (m.source || "").toLowerCase();
  if (source === "app") return true;
  if (source === "workflow" || source === "api") return false;
  if (m.userId && m.userId !== AI_BOT_USER_ID) return true;
  return false;
}

function ts(m) {
  const t = m?.dateAdded ? Date.parse(m.dateAdded) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Analyze a message thread for human activity.
 * @param {Array} messages GHL messages (any order; each has direction/source/userId/dateAdded)
 * @returns {{ humanInThread:boolean, humanMessageCount:number, lastHumanMessageAt:string|null,
 *            lastActivityAt:string|null }}
 */
function analyzeThread(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  let humanCount = 0;
  let lastHuman = null;
  let lastAny = null;
  for (const m of list) {
    const t = ts(m);
    if (t !== null && (lastAny === null || t > lastAny)) lastAny = t;
    if (isHumanMessage(m)) {
      humanCount++;
      if (t !== null && (lastHuman === null || t > lastHuman)) lastHuman = t;
    }
  }
  return {
    humanInThread: humanCount > 0,
    humanMessageCount: humanCount,
    lastHumanMessageAt: lastHuman !== null ? new Date(lastHuman).toISOString() : null,
    lastActivityAt: lastAny !== null ? new Date(lastAny).toISOString() : null,
  };
}

/**
 * Evaluate the decay window. The window resets to 24h from the MOST RECENT activity by either
 * side (so it auto-extends while the conversation is live). The bot may consider resuming only
 * once both sides have been silent for 24h.
 *
 * @param {object} args
 * @param {string|number} args.lastActivityAt ISO or ms of the most recent message (either side)
 * @param {number} [args.now] current time ms (injectable for tests)
 * @returns {{ withinDecay:boolean, decayExpiresAt:string|null, hoursRemaining:number,
 *            shouldCheckResume:boolean }}
 */
function evaluateDecay({ lastActivityAt, now = Date.now() } = {}) {
  const last = typeof lastActivityAt === "number" ? lastActivityAt : Date.parse(lastActivityAt);
  if (!Number.isFinite(last)) {
    // No known activity → nothing to wait on; safe to check resume.
    return { withinDecay: false, decayExpiresAt: null, hoursRemaining: 0, shouldCheckResume: true };
  }
  const expires = last + DECAY_MS;
  const withinDecay = now < expires;
  return {
    withinDecay,
    decayExpiresAt: new Date(expires).toISOString(),
    hoursRemaining: Math.max(0, (expires - now) / 3600000),
    shouldCheckResume: !withinDecay, // decay elapsed → run Signal C (smart resume)
  };
}

/**
 * Convenience: given a thread + now, summarize the back-off decision.
 * - humanInThread + withinDecay  → stay silent (a human is/was here recently)
 * - humanInThread + decay elapsed → run smart-resume check before re-entry
 * - no human                      → bot may proceed normally
 */
function evaluateBackoff({ messages = [], now = Date.now() } = {}) {
  const thread = analyzeThread(messages);
  const decay = evaluateDecay({ lastActivityAt: thread.lastActivityAt, now });
  let decision;
  if (!thread.humanInThread) decision = "proceed";
  else if (decay.withinDecay) decision = "stay_silent";
  else decision = "check_resume";
  return { ...thread, ...decay, decision };
}

module.exports = {
  isHumanMessage,
  analyzeThread,
  evaluateDecay,
  evaluateBackoff,
  AI_BOT_USER_ID,
  DECAY_HOURS,
};
