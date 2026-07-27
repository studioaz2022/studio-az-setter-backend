// consentAutomationCron.js
// Hourly sweep that keeps consent forms ahead of tattoo appointments.
//
// Ticks every 60 minutes over a rolling 24-hour look-ahead window, so every
// appointment is evaluated 23–24h before it starts, and appointments booked
// inside the window are picked up within the hour.

const { runConsentAutomationSweep } = require("./consentAutomationService");

const TICK_MS = 60 * 60 * 1000; // 1 hour — well under the setInterval 24.8-day clamp
const WARMUP_MS = 2 * 60 * 1000; // let the process finish booting before the first pass

let inFlight = false;

async function tick() {
  if (inFlight) {
    console.log("⏳ [Consent Automation] Previous sweep still running, skipping this tick");
    return;
  }
  inFlight = true;
  try {
    await runConsentAutomationSweep();
  } catch (err) {
    console.error("❌ [Consent Automation] Cron tick failed:", err.message);
  } finally {
    inFlight = false;
  }
}

function startConsentAutomationCron() {
  console.log("🧾 Consent automation cron: hourly sweep armed (24h look-ahead)");
  setTimeout(tick, WARMUP_MS);
  setInterval(tick, TICK_MS);
}

module.exports = { startConsentAutomationCron };
