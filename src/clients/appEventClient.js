/**
 * App Event Client
 *
 * Sends events to the Studio AZ Tattoo App webhook server
 * for real-time integration between AI Setter and the iOS app.
 */

const axios = require('axios');

// Webhook server URL (configure via environment variable)
const APP_WEBHOOK_URL = process.env.APP_WEBHOOK_URL || 'http://localhost:3000';

// Event types that the app understands
const EVENT_TYPES = {
  DEPOSIT_PAID: 'deposit_paid',
  LEAD_QUALIFIED: 'lead_qualified',
  APPOINTMENT_BOOKED: 'appointment_booked',
  PHASE_CHANGED: 'phase_changed',
  LEAD_ASSIGNED: 'lead_assigned',
  CONSULTATION_SCHEDULED: 'consultation_scheduled',
  LEAD_DISQUALIFIED: 'lead_disqualified',
  HUMAN_HANDOFF: 'human_handoff',
};

/**
 * Send an event to the app webhook server
 *
 * @param {string} type - Event type from EVENT_TYPES
 * @param {string} contactId - GHL contact ID
 * @param {object} data - Event-specific data
 */
async function sendAppEvent(type, contactId, data = {}) {
  if (!contactId) {
    console.warn('⚠️ sendAppEvent called without contactId, skipping');
    return null;
  }

  const payload = {
    type,
    contactId,
    timestamp: new Date().toISOString(),
    data,
  };

  try {
    const url = `${APP_WEBHOOK_URL}/webhooks/ai-setter/events`;
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000, // 5 second timeout
    });

    console.log(`📱 App event sent: ${type} for contact ${contactId}`);
    return response.data;
  } catch (err) {
    // Don't throw - app events are non-critical
    console.warn(
      `⚠️ Failed to send app event (${type}):`,
      err.response?.status || err.message
    );
    return null;
  }
}

// ============================================================================
// Convenience Functions for Common Events
// ============================================================================

/**
 * Notify app that a deposit was paid
 */
async function notifyDepositPaid(contactId, { amount, paymentId, artistId, consultationType } = {}) {
  return sendAppEvent(EVENT_TYPES.DEPOSIT_PAID, contactId, {
    amount,
    paymentId,
    artistId,
    consultationType,
  });
}

/**
 * Notify app that a lead was qualified
 */
async function notifyLeadQualified(contactId, { assignedArtist, consultationType, tattooSummary } = {}) {
  return sendAppEvent(EVENT_TYPES.LEAD_QUALIFIED, contactId, {
    assignedArtist,
    consultationType,
    tattooSummary,
  });
}

/**
 * Notify app that an appointment was booked
 */
async function notifyAppointmentBooked(contactId, { appointmentId, appointmentTime, artistId, consultationType } = {}) {
  return sendAppEvent(EVENT_TYPES.APPOINTMENT_BOOKED, contactId, {
    appointmentId,
    appointmentTime,
    artistId,
    consultationType,
  });
}

/**
 * Notify app that the lead phase changed
 */
async function notifyPhaseChanged(contactId, { previousPhase, newPhase, leadTemperature } = {}) {
  return sendAppEvent(EVENT_TYPES.PHASE_CHANGED, contactId, {
    previousPhase,
    newPhase,
    leadTemperature,
  });
}

/**
 * Notify app that a lead was assigned to an artist
 */
async function notifyLeadAssigned(contactId, { artistId, artistName } = {}) {
  return sendAppEvent(EVENT_TYPES.LEAD_ASSIGNED, contactId, {
    artistId,
    artistName,
  });
}

/**
 * Notify app that a consultation was scheduled
 */
async function notifyConsultationScheduled(contactId, { appointmentId, appointmentTime, consultationType, artistId } = {}) {
  return sendAppEvent(EVENT_TYPES.CONSULTATION_SCHEDULED, contactId, {
    appointmentId,
    appointmentTime,
    consultationType,
    artistId,
  });
}

/**
 * Notify app that a lead was disqualified
 */
async function notifyLeadDisqualified(contactId, { reason } = {}) {
  return sendAppEvent(EVENT_TYPES.LEAD_DISQUALIFIED, contactId, {
    reason,
  });
}

/**
 * Notify app that a human handoff is needed
 */
async function notifyHumanHandoff(contactId, { reason, assignedTo, lastAIMessage } = {}) {
  return sendAppEvent(EVENT_TYPES.HUMAN_HANDOFF, contactId, {
    reason,
    assignedTo,
    lastAIMessage,
  });
}

module.exports = {
  EVENT_TYPES,
  sendAppEvent,
  notifyDepositPaid,
  notifyLeadQualified,
  notifyAppointmentBooked,
  notifyPhaseChanged,
  notifyLeadAssigned,
  notifyConsultationScheduled,
  notifyLeadDisqualified,
  notifyHumanHandoff,
};
