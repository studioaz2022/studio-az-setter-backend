// escalation.js — decide when to upgrade the conversational model Haiku 4.5 → Sonnet 4.6 (Phase 3).
//
// Hard conversations (objections, pushback, circling) get Sonnet's deeper reasoning; everything
// else stays on cheap, fast Haiku. We decide BEFORE the call using cheap signals so escalation
// costs no extra round-trip:
//   1. An objection is detected in the lead's last message.
//   2. The lead expressed hesitation / doubt / pushback.
//   3. The conversation is circling (3+ objection-ish turns).
//
// We reuse the EXISTING regex objection library purely as a routing signal here — the LLM still
// does the actual objection HANDLING via objection_principles.md. The regex just flags "this turn
// is hard, send it to the smarter model + tag it for the objection log."

const { detectObjection } = require("../../prompts/objectionLibrary");
const { MODELS } = require("./anthropicClient");

// Explicit hesitation / pushback the objection library might miss.
const PUSHBACK_RE = /\b(but|however|not sure|hesitant|skeptical|doubt|worried|nervous|too much|can't afford|expensive|think about it|need time|maybe later|idk|i don'?t know|no estoy segur|no sé|caro|pensarlo|más adelante)\b/i;

// v2-only supplemental detectors for common phrasings the SHARED v1 regex library misses.
// Kept here (not in objectionLibrary.js) so we don't perturb the live v1 bot. Each maps to a
// real objection id so escalation still logs the right category.
const SUPPLEMENTAL_OBJECTIONS = [
  { id: "price_too_high", re: /\bseems? like a lot\b|\b(bit |kinda |pretty |lil )?steep\b|\bpricey\b|\ba lot (just )?to (talk|chat)\b|\bthat'?s pricey\b/i },
  { id: "exact_price_now", re: /\bhow much.{0,20}(cost|be|is it)\b|\bwhat'?s the (total |rough )?(cost|price)\b|\bgive me a (rough )?(price|number|cost)\b/i },
];

/** Detect an objection via the shared library, falling back to v2 supplemental patterns. */
function detectObjectionV2(text) {
  const fromLib = detectObjection(text);
  if (fromLib) return { id: fromLib.id, source: "library" };
  if (typeof text === "string") {
    for (const s of SUPPLEMENTAL_OBJECTIONS) {
      if (s.re.test(text)) return { id: s.id, source: "supplemental" };
    }
  }
  return null;
}

function isObjectionish(text) {
  if (!text || typeof text !== "string") return false;
  return !!detectObjectionV2(text) || PUSHBACK_RE.test(text);
}

// A specific clock time in the BOT's OWN prior messages means we've reached the scheduling close
// (a slot has been offered, and what follows is confirming + booking it). That's the highest-stakes
// moment and the one Haiku keeps fumbling — it understands the lead fine but fails to fire the
// create_hold tool and loops on "which day?" So we route the close to Sonnet. This is a routing
// signal that looks ONLY at the bot's own output (matches en "10:00 AM" / es "10:00 a. m."); it does
// NOT interpret the lead's words, so it adds no conversational rules.
const TIME_OFFERED_RE = /\b\d{1,2}(:\d{2})?\s*[ap]\.?\s?m\b/i;

function botOfferedTime(history = []) {
  return (history || []).some((m) => m.role === "assistant" && TIME_OFFERED_RE.test(m.content || ""));
}

/**
 * Count how many of the lead's (user) turns look like objections/pushback. 3+ ⇒ circling.
 * @param {Array} history normalized turns ({role, content})
 * @param {string} latestMessageText
 */
function countObjectionTurns(history = [], latestMessageText = "") {
  let n = 0;
  for (const m of history) {
    if (m.role === "user" && isObjectionish(m.content)) n++;
  }
  if (isObjectionish(latestMessageText)) n++;
  return n;
}

/**
 * Decide whether to escalate this turn to Sonnet.
 * @param {object} args
 * @param {string} args.latestMessageText the lead's latest message
 * @param {Array}  [args.history] prior normalized turns
 * @returns {{escalate:boolean, model:string, reason:string|null, objectionId:string|null}}
 */
function decideModel({ latestMessageText = "", history = [], faqMode = false } = {}) {
  const objection = detectObjectionV2(latestMessageText);
  const objectionId = objection ? objection.id : null;

  // 3+ objection-ish turns across the conversation ⇒ circling.
  const objectionTurns = countObjectionTurns(history, latestMessageText);
  const circling = objectionTurns >= 3;

  // Scheduling close: the bot has already put a specific time on the table and the deposit isn't
  // paid yet → route the confirm-and-book turns to Sonnet. (Skip in faqMode — the sale's done.)
  const schedulingClose = !faqMode && botOfferedTime(history);

  let reason = null;
  if (objection) reason = `objection:${objectionId}`;
  else if (PUSHBACK_RE.test(latestMessageText)) reason = "pushback";
  if (circling) reason = reason ? `${reason}+circling` : "circling";
  if (schedulingClose) reason = reason ? `${reason}+scheduling_close` : "scheduling_close";

  const escalate = !!reason;
  return {
    escalate,
    model: escalate ? MODELS.SONNET : MODELS.HAIKU,
    reason,
    objectionId,
  };
}

module.exports = { decideModel, isObjectionish, countObjectionTurns, botOfferedTime, PUSHBACK_RE };
