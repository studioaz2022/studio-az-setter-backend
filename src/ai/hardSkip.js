// hardSkip.js
// Decide whether to bypass AI generation for deterministic system responses.
// 
// NOTE: With conversation thread context, the AI can now handle many scenarios naturally.
// We only hard-skip for actions that REQUIRE backend API calls (scheduling, payments, etc.)

function shouldHardSkipAI({ intents = {}, derivedPhase = null, canonicalState = {} }) {
  // Reschedule/Cancel → Needs appointment status API calls
  if (intents.reschedule_intent || intents.cancel_intent) {
    return { skip: true, reason: "reschedule_or_cancel" };
  }

  // Slot selection → Needs calendar API to create hold + Square API for deposit link
  if (intents.slot_selection_intent) {
    return { skip: true, reason: "slot_selection" };
  }

  // Deposit intent → Needs Square API to create payment link
  // Multi-intent handling - if they ask a question alongside deposit intent,
  // route to deterministic but with awareness of the question
  if (intents.deposit_intent && intents.consult_path_choice_intent) {
    return { skip: true, reason: "deposit_with_consult_question" };
  }

  if (intents.deposit_intent) {
    return { skip: true, reason: "deposit_intent" };
  }

  // Scheduling intent → Needs calendar API to fetch real availability
  if (intents.scheduling_intent) {
    return { skip: true, reason: "scheduling_intent" };
  }

  // REMOVED: process_or_price_question_intent skip
  // AI can now handle this naturally with thread context - it sees what was already explained

  // REMOVED: translator_affirm_intent skip  
  // We now auto-confirm translator when video is selected in consultPathHandler
  // No need for separate affirmation flow

  return { skip: false, reason: null };
}

module.exports = {
  shouldHardSkipAI,
};
