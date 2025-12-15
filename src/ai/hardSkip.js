// hardSkip.js
// Decide whether to bypass AI generation for deterministic system responses.

function shouldHardSkipAI({ intents = {}, derivedPhase = null, canonicalState = {} }) {
  if (intents.reschedule_intent || intents.cancel_intent) {
    return { skip: true, reason: "reschedule_or_cancel" };
  }

  if (intents.slot_selection_intent) {
    return { skip: true, reason: "slot_selection" };
  }

  if (intents.deposit_intent) {
    return { skip: true, reason: "deposit_intent" };
  }

  if (intents.process_or_price_question_intent && canonicalState?.consultExplained) {
    return { skip: true, reason: "process_after_explained" };
  }

  if (intents.scheduling_intent) {
    return { skip: true, reason: "scheduling_intent" };
  }

  if (intents.translator_affirm_intent) {
    return { skip: true, reason: "translator_affirm" };
  }

  return { skip: false, reason: null };
}

module.exports = {
  shouldHardSkipAI,
};
