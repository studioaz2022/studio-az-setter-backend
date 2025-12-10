// returningClientDetector.js
// Pure helper to determine if a contact is a returning client using local data.

const { boolField } = require("./opportunityManager");

const RETURNING_TAGS = ["past-client", "past client", "tattoo client"];
const CONFIRMED_STATUSES = new Set(["confirmed", "showed", "completed"]);

function normalizeTags(rawTags = []) {
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .filter(Boolean)
    .map((t) => String(t).trim())
    .filter((t) => t.length > 0);
}

function hasReturningTag(tags = []) {
  const lower = normalizeTags(tags).map((t) => t.toLowerCase());
  return RETURNING_TAGS.some((needle) => lower.includes(needle));
}

function parseNumber(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function analyzeAppointments(appointments = []) {
  const now = Date.now();
  let pastAppointmentCount = 0;
  let lastAppointmentAt = null;
  const artistsSeen = new Set();

  for (const apt of appointments) {
    if (!apt) continue;
    const status = String(apt.appointmentStatus || "").toLowerCase();
    const start = apt.startTime ? new Date(apt.startTime).getTime() : null;
    if (!start || start > now) continue; // only count past appointments
    if (!CONFIRMED_STATUSES.has(status)) continue;

    pastAppointmentCount += 1;
    if (!lastAppointmentAt || start > lastAppointmentAt) {
      lastAppointmentAt = start;
    }

    if (apt.assignedUserId) {
      artistsSeen.add(String(apt.assignedUserId));
    } else if (apt.userId) {
      artistsSeen.add(String(apt.userId));
    }
  }

  return {
    pastAppointmentCount,
    lastAppointmentAt: lastAppointmentAt ? new Date(lastAppointmentAt).toISOString() : null,
    artistsSeen: Array.from(artistsSeen),
  };
}

function notesSuggestReturning(notesText) {
  if (!notesText || typeof notesText !== "string") return false;
  const v = notesText.toLowerCase();
  const patterns = [
    "another piece",
    "another tattoo",
    "second tattoo",
    "second piece",
    "back for",
    "came back",
    "touch up",
    "touch-up",
    "cover up old",
    "cover-up old",
  ];
  return patterns.some((p) => v.includes(p));
}

/**
 * Detect returning client signals.
 * @param {Object} params
 * @param {Object} params.contact - GHL contact record (required)
 * @param {Array} params.appointments - Appointment objects (optional)
 * @returns {Object} { isReturningClient, signals, appointmentStats }
 */
function detectReturningClient({ contact, appointments = [] }) {
  if (!contact || typeof contact !== "object") {
    return {
      isReturningClient: false,
      signals: {},
      appointmentStats: { pastAppointmentCount: 0, lastAppointmentAt: null, artistsSeen: [] },
    };
  }

  const cf = contact.customField || contact.customFields || {};
  const tags = contact.tags || [];
  const appointmentStats = analyzeAppointments(appointments);

  const returningFieldFlag = boolField(cf.returning_client);
  const totalTattoosCompleted = parseNumber(cf.total_tattoos_completed) || 0;
  const clientLifetimeValue = parseNumber(cf.client_lifetime_value) || 0;
  const hasReturningTags = hasReturningTag(tags);
  const notesText = contact.notes || contact.note || contact.description || "";
  const notesFlag = notesSuggestReturning(notesText);

  const hasStrongEvidence =
    returningFieldFlag ||
    hasReturningTags ||
    totalTattoosCompleted > 0 ||
    appointmentStats.pastAppointmentCount > 0;

  const hasModerateEvidence = clientLifetimeValue > 0;
  const hasWeakEvidence = notesFlag;

  const isReturningClient = Boolean(
    hasStrongEvidence || (hasModerateEvidence && hasWeakEvidence)
  );

  const signals = {
    returningFieldFlag,
    hasReturningTags,
    totalTattoosCompleted,
    clientLifetimeValue,
    notesFlag,
  };

  return {
    isReturningClient,
    signals,
    appointmentStats,
  };
}

module.exports = {
  detectReturningClient,
  analyzeAppointments,
};
