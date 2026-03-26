// consentReminderCron.js
// Daily cron job that sends day-of consent form reminders at 8:00 AM Central.

const { sendDayOfConsentReminders } = require("./consentFormService");

/**
 * Start the daily consent reminder cron schedule.
 * Fires every day at 8:00 AM Central time.
 */
function startConsentReminderCron() {
  function scheduleNext() {
    const now = new Date();

    // Get current Central time
    const centralFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = centralFormatter.formatToParts(now);
    const get = (type) => parseInt(parts.find((p) => p.type === type).value);
    const centralHour = get("hour");
    const centralMinute = get("minute");
    const centralSecond = get("second");

    // Target: 8:00 AM Central
    const TARGET_HOUR = 8;
    const TARGET_MINUTE = 0;

    let msUntilTarget;
    const currentMs =
      centralHour * 3600000 + centralMinute * 60000 + centralSecond * 1000;
    const targetMs = TARGET_HOUR * 3600000 + TARGET_MINUTE * 60000;

    if (currentMs < targetMs) {
      // Target is later today
      msUntilTarget = targetMs - currentMs;
    } else {
      // Target is tomorrow
      msUntilTarget = 24 * 3600000 - currentMs + targetMs;
    }

    const hoursUntil = (msUntilTarget / 3600000).toFixed(1);
    console.log(
      `🔔 Consent reminder cron: next run in ${hoursUntil}h (8:00 AM Central)`
    );

    setTimeout(async () => {
      console.log("🔔 Running day-of consent form reminders...");
      try {
        const result = await sendDayOfConsentReminders();
        console.log(
          `🔔 Consent reminders done: ${result.sent || 0} sent, ${result.errors || 0} errors`
        );
      } catch (err) {
        console.error("❌ Consent reminder cron error:", err.message);
      }
      // Schedule next run
      scheduleNext();
    }, msUntilTarget);
  }

  scheduleNext();
}

module.exports = { startConsentReminderCron };
