// holdLifecycle.js
// Activity-based hold lifecycle management (warning + release) per addendum.

const { updateAppointmentStatus } = require("../clients/ghlCalendarClient");
const { updateSystemFields } = require("../../ghlClient");
const { APPOINTMENT_STATUS } = require("../config/constants");
const { sendConversationMessage } = require("../../ghlClient");

function buildChannelContext(contact = {}) {
  const hasPhone = !!(contact.phone || contact.phoneNumber);
  const tags = contact.tags || [];
  const isDm = tags.some(
    (t) =>
      typeof t === "string" &&
      (t.includes("INSTAGRAM") || t.includes("FACEBOOK") || t.includes("DM"))
  );

  return {
    isDm,
    hasPhone,
    conversationId: null,
    phone: contact.phone || contact.phoneNumber || null,
  };
}

/**
 * Evaluate hold lifecycle and perform warning/release as needed.
 * @returns {Object} result { warned?: boolean, released?: boolean }
 */
async function evaluateHoldState({ contact, canonicalState, now = new Date() }) {
  const contactId = contact?.id || contact?._id;
  const holdId = canonicalState?.holdAppointmentId;
  const lastActivity = canonicalState?.holdLastActivityAt
    ? new Date(canonicalState.holdLastActivityAt)
    : null;
  const depositPaid = canonicalState?.depositPaid === true;

  if (!contactId || !holdId || depositPaid) {
    return { warned: false, released: false };
  }

  if (!lastActivity || Number.isNaN(lastActivity.getTime())) {
    return { warned: false, released: false };
  }

  const elapsedMs = now.getTime() - lastActivity.getTime();
  const tenMinutes = 10 * 60 * 1000;
  const twentyMinutes = 20 * 60 * 1000;

  const channelContext = buildChannelContext(contact);

  // Release at 20 minutes since last activity
  if (elapsedMs >= twentyMinutes) {
    try {
      await updateAppointmentStatus(holdId, APPOINTMENT_STATUS.CANCELLED);
    } catch (err) {
      console.error("❌ Failed to cancel hold appointment during release:", err.message || err);
    }

    try {
      await updateSystemFields(contactId, {
        hold_appointment_id: null,
        hold_created_at: null,
        hold_last_activity_at: null,
        hold_warning_sent: false,
        last_sent_slots: null,
      });
    } catch (err) {
      console.error("❌ Failed to clear hold fields on release:", err.message || err);
    }

    const releaseMsg =
      "I released that consult hold so others can book it. Tell me what day/time works and I’ll grab the next best slot.";
    try {
      await sendConversationMessage({
        contactId,
        body: releaseMsg,
        channelContext,
      });
    } catch (err) {
      console.error("❌ Failed to send hold release message:", err.message || err);
    }

    return { warned: false, released: true };
  }

  // Warning at 10 minutes since last activity (only once)
  if (!canonicalState?.holdWarningSent && elapsedMs >= tenMinutes) {
    const warnMsg =
      "Quick heads up—I’m still holding that consult time. I’ll need to release it soon if the deposit isn’t done.";
    try {
      await sendConversationMessage({
        contactId,
        body: warnMsg,
        channelContext,
      });
      await updateSystemFields(contactId, {
        hold_warning_sent: true,
      });
    } catch (err) {
      console.error("❌ Failed to send or mark hold warning:", err.message || err);
    }
    return { warned: true, released: false };
  }

  // Update last activity timestamp on every inbound while hold exists and deposit not paid
  try {
    await updateSystemFields(contactId, {
      hold_last_activity_at: now.toISOString(),
    });
  } catch (err) {
    console.error("❌ Failed to refresh hold_last_activity_at:", err.message || err);
  }

  return { warned: false, released: false };
}

module.exports = {
  evaluateHoldState,
};
