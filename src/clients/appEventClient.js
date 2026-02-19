/**
 * App Event Client
 *
 * Dispatches events to the AI Setter event handler for real-time integration
 * between the AI Setter bot and the iOS app's Command Center.
 *
 * Previously sent HTTP requests to a separate webhook server.
 * Now calls the handler directly as an in-process function call.
 */

const { handleAISetterEvent } = require('./aiSetterEventHandler');

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
  CREATE_TASK: 'create_task',  // Creates a task in iOS app Command Center
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
    const result = await handleAISetterEvent(payload);
    console.log(`📱 App event processed: ${type} for contact ${contactId}`);
    return result;
  } catch (err) {
    // Don't throw - app events are non-critical
    console.warn(
      `⚠️ Failed to process app event (${type}):`,
      err.message
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
