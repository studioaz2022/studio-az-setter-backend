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

  const v = String(howSoonRaw).toLowerCase().trim();

  // 🔥 HOT (ASAP / within ~1 month)
  if (
    v.includes("soonest") ||
    v.includes("soon as possible") ||
    v.includes("asap") ||
    v === "soonest possible" ||
    v.includes("in a month") ||
    v === "en un mes" ||          // Spanish: in a month
    v.includes("lo antes posible")
  ) {
    return "hot";
  }

  // 🔥/🟠 WARM (1–3 months, Spanish + English)
  if (
    v.includes("1-3 months") ||
    v.includes("1 – 3 months") ||
    v.includes("1 to 3 months") ||
    v.includes("three months") ||
    v.includes("1-3 meses") ||
    v.includes("1 a 3 meses") ||
    v.includes("uno a tres meses")
  ) {
    return "warm";
  }

  // 🧊 COLD (undecided)
  if (v.includes("not sure") || v.includes("still deciding") ||
      v.includes("no estoy seguro") || v.includes("aún estoy decidiendo")) {
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
    return "intake"; // first inbound DM/SMS should behave like intake
  }
  // Later we can add more complex transitions here.
  return currentPhase;
}

module.exports = {
  decideLeadTemperature,
  initialPhaseForNewIntake,
  decidePhaseForMessage,
};
