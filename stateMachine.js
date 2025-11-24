// stateMachine.js

/**
 * Decide lead_temperature based on how soon they're deciding.
 * Expects the *value* you store in your custom field, e.g.:
 *  - "Soonest Possible"
 *  - "In a Month"
 *  - "1-3 Months"
 *  - "Not Sure. I'm Still Deciding."
 */
function decideLeadTemperature(howSoonRaw) {
  if (!howSoonRaw) return "cold";

  const v = String(howSoonRaw).toLowerCase();

  if (v.includes("soonest") || v.includes("soon as possible") || v.includes("in a month")) {
    return "hot";
  }

  if (v.includes("1-3 months") || v.includes("1 to 3 months") || v.includes("3 months")) {
    return "warm";
  }

  if (v.includes("not sure") || v.includes("still deciding")) {
    return "cold";
  }

  // Default conservative
  return "cold";
}

/**
 * Decide initial ai_phase for form webhook.
 * This is basically the "intake is done; we're ready to open the conversation" phase.
 */
function initialPhaseForNewIntake() {
  return "intake"; // later our AI will use this to run the "Opener" script
}

/**
 * Decide ai_phase for a message webhook.
 * For now, keep this simple: if we don't have a phase yet, use "discovery".
 */
function decidePhaseForMessage(currentPhase) {
  if (!currentPhase || currentPhase.trim() === "") {
    return "discovery";
  }
  // Later we can add more complex transitions here.
  return currentPhase;
}

module.exports = {
  decideLeadTemperature,
  initialPhaseForNewIntake,
  decidePhaseForMessage,
};
