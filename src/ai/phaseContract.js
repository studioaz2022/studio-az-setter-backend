const { AI_PHASES, SYSTEM_FIELDS, TATTOO_FIELDS } = require("../config/constants");
const { normalizeCustomFields, normalizeDisplayName } = require("./contextBuilder");

function boolVal(raw) {
  if (raw === true || raw === false) return raw;
  if (raw === undefined || raw === null) return false;
  const v = String(raw).toLowerCase();
  return v === "yes" || v === "true" || v === "1";
}

function parseJsonField(raw, fallback) {
  if (!raw) return fallback;
  if (Array.isArray(raw) || typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function detectArtistGuidedSize(messageText) {
  if (!messageText) return false;
  const v = String(messageText).toLowerCase();
  const patterns = [
    "not sure",
    "i don't know",
    "idk",
    "help me decide",
    "help me figure",
    "second opinion",
    "whatever you think",
    "you tell me",
    "artist decide",
    "artist can decide",
  ];
  return patterns.some((phrase) => v.includes(phrase));
}

function buildCanonicalState(contact = {}) {
  const cfRaw = contact.customField || contact.customFields || {};
  
  // Normalize custom fields from various formats
  const cf = normalizeCustomFields(cfRaw);

  const lastSentSlotsRaw = cf.last_sent_slots || null;
  const lastSeenSnapshotRaw = cf[SYSTEM_FIELDS.LAST_SEEN_FIELDS] || cf.last_seen_fields_snapshot || null;
  const consultAppointmentId = cf.consult_appointment_id || cf.appointment_id || null;
  const holdAppointmentId = cf[SYSTEM_FIELDS.HOLD_APPOINTMENT_ID] || null;

  return {
    opportunityId: cf[SYSTEM_FIELDS.OPPORTUNITY_ID] || null,
    opportunityStage: cf[SYSTEM_FIELDS.OPPORTUNITY_STAGE] || null,
    languagePreference: cf[TATTOO_FIELDS.LANGUAGE_PREFERENCE] || cf[SYSTEM_FIELDS.LANGUAGE_PREFERENCE] || null,
    tattooTitle: cf[TATTOO_FIELDS.TATTOO_TITLE] || null,
    tattooSummary: cf[TATTOO_FIELDS.TATTOO_SUMMARY] || null,
    tattooPlacement: cf[TATTOO_FIELDS.TATTOO_PLACEMENT] || null,
    // Canonical key is tattoo_size; keep fallback read for legacy size_of_tattoo
    tattooSize: cf[TATTOO_FIELDS.SIZE_OF_TATTOO] || cf.size_of_tattoo || null,
    tattooSizeNotes: cf[TATTOO_FIELDS.TATTOO_SIZE_NOTES] || null,
    tattooStyle: cf[TATTOO_FIELDS.TATTOO_STYLE] || null,
    tattooColorPreference: cf[TATTOO_FIELDS.TATTOO_COLOR_PREFERENCE] || null,
    timeline: cf[TATTOO_FIELDS.HOW_SOON_IS_CLIENT_DECIDING] || null,
    firstTattoo: boolVal(cf[TATTOO_FIELDS.FIRST_TATTOO]),
    tattooConcerns: cf[TATTOO_FIELDS.TATTOO_CONCERNS] || null,
    tattooPhotoDescription: cf[TATTOO_FIELDS.TATTOO_PHOTO_DESCRIPTION] || null,
    inquiredTechnician: cf[TATTOO_FIELDS.INQUIRED_TECHNICIAN] || null,
    consultationType: cf[SYSTEM_FIELDS.CONSULTATION_TYPE] || null,
    consultationTypeLocked: boolVal(cf[SYSTEM_FIELDS.CONSULTATION_TYPE_LOCKED]),
    consultExplained: boolVal(cf[SYSTEM_FIELDS.CONSULT_EXPLAINED]),
    languageBarrierExplained: boolVal(cf.language_barrier_explained),
    translatorExplained: boolVal(cf[SYSTEM_FIELDS.TRANSLATOR_EXPLAINED] || cf.language_barrier_explained),
    translatorNeeded: boolVal(cf[SYSTEM_FIELDS.TRANSLATOR_NEEDED]),
    translatorConfirmed: boolVal(cf[SYSTEM_FIELDS.TRANSLATOR_CONFIRMED]),
    depositLinkSent: boolVal(cf[SYSTEM_FIELDS.DEPOSIT_LINK_SENT]),
    depositPaid: boolVal(cf[SYSTEM_FIELDS.DEPOSIT_PAID]),
    holdAppointmentId,
    holdLastActivityAt: cf[SYSTEM_FIELDS.HOLD_LAST_ACTIVITY_AT] || null,
    holdWarningSent: boolVal(cf[SYSTEM_FIELDS.HOLD_WARNING_SENT]),
    appointmentBooked:
      boolVal(cf.appointment_booked) ||
      !!consultAppointmentId,
    upcomingAppointmentId: consultAppointmentId || holdAppointmentId || null,
    timesSent: boolVal(cf.times_sent),
    lastSentSlots: parseJsonField(lastSentSlotsRaw, []),
    lastSeenSnapshot: parseJsonField(lastSeenSnapshotRaw, {}),
    depositLinkUrl: cf.deposit_link_url || null,
  };
}

function derivePhase(state, { schedulingIntent = false, slotSelected = false } = {}) {
  if (!state) return AI_PHASES.INTAKE;

  const sizeSatisfied =
    !!state.tattooSize && String(state.tattooSize).toLowerCase() !== "";
  const timelineCaptured = !!state.timeline;
  const consultChosen = !!state.consultationType || state.consultationTypeLocked;

  if (state.appointmentBooked && state.depositPaid) {
    return AI_PHASES.BOOKED;
  }

  if (state.depositPaid) {
    return AI_PHASES.QUALIFIED;
  }

  if (state.holdAppointmentId || (state.depositLinkSent && !state.depositPaid)) {
    return AI_PHASES.DEPOSIT_PENDING;
  }

  if (consultChosen && (schedulingIntent || state.timesSent || slotSelected)) {
    return AI_PHASES.SCHEDULING;
  }

  if (timelineCaptured && !consultChosen) {
    return AI_PHASES.CONSULT_PATH;
  }

  if (
    state.tattooSummary &&
    state.tattooPlacement &&
    (sizeSatisfied || String(state.tattooSize).toLowerCase() === "artist_guided") &&
    !timelineCaptured
  ) {
    return AI_PHASES.QUALIFICATION;
  }

  if (!state.tattooSummary || !state.tattooPlacement) {
    return AI_PHASES.INTAKE;
  }

  return AI_PHASES.DISCOVERY;
}

/**
 * Deterministic phase derivation using canonical state.
 * Matches the frozen implementation spec and addendum rules.
 */
function derivePhaseFromFields(state) {
  if (!state) return AI_PHASES.INTAKE;

  const sizeValue = String(state.tattooSize || "").toLowerCase();
  const sizeSatisfied =
    (state.tattooSize !== undefined &&
      state.tattooSize !== null &&
      sizeValue !== "") ||
    sizeValue === "artist_guided";
  const timelineCaptured = !!state.timeline;
  const consultChosen = !!state.consultationType || state.consultationTypeLocked;
  const hasSlotsSent =
    state.timesSent === true ||
    (Array.isArray(state.lastSentSlots) && state.lastSentSlots.length > 0);

  // Booking / post-booking
  if (state.appointmentBooked && state.depositPaid) {
    return AI_PHASES.BOOKED;
  }

  if (state.depositPaid) {
    return AI_PHASES.QUALIFIED;
  }

  // Deposit/hold pending
  if (state.holdAppointmentId || (state.depositLinkSent && !state.depositPaid)) {
    return AI_PHASES.DEPOSIT_PENDING;
  }

  // Scheduling phase once consult is chosen/locked and we are offering slots
  if (consultChosen && (hasSlotsSent)) {
    return AI_PHASES.SCHEDULING;
  }

  // Consult path selection once timeline known but consult path not set/locked
  if (timelineCaptured && !consultChosen) {
    return AI_PHASES.CONSULT_PATH;
  }

  // Qualification once core info present and timeline missing
  if (state.tattooSummary && state.tattooPlacement && sizeSatisfied && !timelineCaptured) {
    return AI_PHASES.QUALIFICATION;
  }

  // Intake until placement + summary are both present
  if (!state.tattooSummary || !state.tattooPlacement) {
    return AI_PHASES.INTAKE;
  }

  // Default discovery catch-all
  return AI_PHASES.DISCOVERY;
}

function computeLastSeenDiff(state, previousSnapshot = {}) {
  const tracked = [
    "tattooSummary",
    "tattooPlacement",
    "tattooSize",
    "tattooStyle",
    "timeline",
    "consultationType",
  ];
  const updatedSnapshot = { ...previousSnapshot };
  const changedFields = {};

  tracked.forEach((key) => {
    const current = state[key] || null;
    const prev = previousSnapshot[key] || null;
    if (current !== prev && current !== undefined) {
      changedFields[key] = current;
      updatedSnapshot[key] = current;
    }
  });

  return { updatedSnapshot, changedFields };
}

module.exports = {
  boolVal,
  parseJsonField,
  detectArtistGuidedSize,
  normalizeCustomFields,
  normalizeDisplayName,
  buildCanonicalState,
  derivePhase,
  derivePhaseFromFields,
  computeLastSeenDiff,
};
