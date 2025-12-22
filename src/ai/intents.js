// intents.js
// Pure intent detection helper for inbound messages

const { isTimeSelection } = require("./bookingController");
const { detectArtistGuidedSize } = require("./phaseContract");
const { detectObjection } = require("../prompts/objectionLibrary");

/**
 * Detects intent flags from a lead message.
 * @param {string} messageText
 * @param {object} canonicalState - reserved for future use (kept for API parity)
 * @returns {object} intent flags
 */
function detectIntents(messageText, canonicalState = {}) {
  const intents = {
    reschedule_intent: false,
    cancel_intent: false,
    scheduling_intent: false,
    slot_selection_intent: false,
    deposit_intent: false,
    consult_path_choice_intent: false,
    artist_guided_size_intent: false,
    process_or_price_question_intent: false,
    // Objection detection
    objection_intent: false,
    objection_type: null,
    objection_data: null,
    // REMOVED: translator_affirm_intent - now auto-confirmed when video is selected
  };

  if (!messageText) {
    return intents;
  }

  const lower = String(messageText).toLowerCase();

  // Objection detection (sales resistance, hesitation, concerns)
  const objection = detectObjection(messageText);
  if (objection) {
    intents.objection_intent = true;
    intents.objection_type = objection.id;
    intents.objection_data = objection;
  }

  // Reschedule intent
  if (
    /\bresched/i.test(lower) ||
    /\banother day\b/.test(lower) ||
    /\bdifferent (day|time|date)\b/.test(lower) ||
    /\bmove (it|the|my)?\s*(time|date|appointment)?\b/.test(lower) ||
    /\bchange (the )?(time|date)\b/.test(lower)
  ) {
    intents.reschedule_intent = true;
  }

  // Cancel intent
  if (/\bcancel\b/.test(lower) || /can't make it/.test(lower)) {
    intents.cancel_intent = true;
  }

  // Scheduling intent (asks for availability/times)
  const schedulingPatterns = [
    /\bwhat (times|time|days)\b/,
    /\bavailability\b/,
    /\bavailable\b/,
    /\bopenings?\b/,
    /\bslots?\b/,
    /\bschedule\b/,
    /\bscheduling\b/,
    /\bwhen can i (come|book|schedule)\b/,
    /\bwhat day works\b/,
    /\bwhich day\b/,
    /\bthis week\b/,
    /\bnext week\b/,
    /\btoday\b/,
    /\btomorrow\b/,
  ];
  if (schedulingPatterns.some((re) => re.test(lower))) {
    intents.scheduling_intent = true;
  }

  // Slot selection intent (explicit choice or time)
  const slotSelectionPatterns = [
    /\boption\s*[1-9]\b/,
    /#\s?\d+\b/,
    /\b(first|second|third)\s+one\b/,
    /\b(tuesday|wednesday|thursday|friday|monday|saturday|sunday)\b.*\b\d{1,2}\s*(am|pm)\b/,
  ];
  if (
    slotSelectionPatterns.some((re) => re.test(lower)) ||
    isTimeSelection(messageText, [])
  ) {
    intents.slot_selection_intent = true;
  }

  // Deposit intent
  if (
    /\bdeposit\b/.test(lower) ||
    /\bpay(ment)? link\b/.test(lower) ||
    /\bpay now\b/.test(lower) ||
    /\bready to pay\b/.test(lower) ||
    /\bsend (me )?the link\b/.test(lower)
  ) {
    intents.deposit_intent = true;
  }

  // Consult path choice intent (video / in-person / messages)
  const consultPatterns = [
    /\bvideo (call)?\b/,
    /\bzoom\b/,
    /\btranslator\b/,
    /\bcall\b/,
    /\bphone\b/,
    /\bin[-\s]?person\b/,
    /\bstudio\b/,
    /\bcome in\b/,
    /\bmessages?\b/,
    /\bchat\b/,
    /\bdm\b/,
  ];
  if (consultPatterns.some((re) => re.test(lower))) {
    intents.consult_path_choice_intent = true;
  }

  // Artist-guided size intent (uncertain sizing)
  if (detectArtistGuidedSize(messageText)) {
    intents.artist_guided_size_intent = true;
  }

  // Process or price questions
  if (
    /\bhow much\b/.test(lower) ||
    /\bprice\b/.test(lower) ||
    /\bcost\b/.test(lower) ||
    /\brate\b/.test(lower) ||
    /\bhow does (it|this) work\b/.test(lower) ||
    /\bwhat('s| is) the process\b/.test(lower) ||
    /\bprocess\b/.test(lower)
  ) {
    intents.process_or_price_question_intent = true;
  }

  // REMOVED: translator_affirm_intent detection
  // Translator is now auto-confirmed when lead selects "video call" in consultPathHandler
  // This eliminates the redundant "Does that work for you?" step

  return intents;
}

module.exports = {
  detectIntents,
};
