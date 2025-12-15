const { SYSTEM_FIELDS, TATTOO_FIELDS } = require("../config/constants");

/**
 * Normalize display name to snake_case key.
 * "Tattoo Placement" -> "tattoo_placement"
 * "How Soon Is Client Deciding?" -> "how_soon_is_client_deciding"
 */
function normalizeDisplayName(displayName) {
  if (!displayName || typeof displayName !== "string") return null;
  return displayName
    .toLowerCase()
    .replace(/[?!.,]/g, "")
    .replace(/\s+/g, "_")
    .trim();
}

/**
 * Normalize custom fields from various GHL formats to a key-value object.
 * Handles:
 * - Already normalized object: { tattoo_placement: "forearm" }
 * - Array format: [{ id: "xxx", value: "forearm" }]
 * - Array-like object: { "0": { id: "xxx", value: "forearm" } }
 * - Display name keys: { "Tattoo Placement": "forearm" }
 */
function normalizeCustomFields(cfRaw) {
  if (!cfRaw) return {};

  let normalized = {};

  // Check if it's an array
  if (Array.isArray(cfRaw)) {
    for (const entry of cfRaw) {
      if (!entry) continue;
      const key =
        entry.key ||
        entry.fieldKey ||
        entry.customFieldKey ||
        entry.customFieldId ||
        entry.id;
      if (key && entry.value !== undefined) {
        const snakeKey = normalizeDisplayName(String(key));
        normalized[snakeKey || key] = entry.value;
      }
    }
    return normalized;
  }

  // Check if it's an array-like object with numeric keys
  const keys = Object.keys(cfRaw);
  const isArrayLike = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));

  if (isArrayLike) {
    for (const key of keys) {
      const entry = cfRaw[key];
      if (!entry || typeof entry !== "object") continue;
      const fieldKey =
        entry.key ||
        entry.fieldKey ||
        entry.customFieldKey ||
        entry.customFieldId ||
        entry.id;
      if (fieldKey && entry.value !== undefined) {
        const snakeKey = normalizeDisplayName(String(fieldKey));
        normalized[snakeKey || fieldKey] = entry.value;
      }
    }
    return normalized;
  }

  // It's a regular object - normalize display name keys to snake_case
  for (const [key, value] of Object.entries(cfRaw)) {
    if (value === undefined || value === null || value === "") continue;

    // Skip nested objects (like location, contact, etc.)
    if (typeof value === "object" && !Array.isArray(value)) continue;

    const snakeKey = normalizeDisplayName(key);
    if (snakeKey) {
      normalized[snakeKey] = value;
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

function buildAllowedFieldSet() {
  const canonicalKeys = [
    ...Object.values(TATTOO_FIELDS || {}),
    ...Object.values(SYSTEM_FIELDS || {}),
    "tattoo_size",
    "tattoo_size_notes",
    "tattoo_title",
    "tattoo_summary",
    "tattoo_placement",
    "tattoo_style",
    "tattoo_color_preference",
    "how_soon_is_client_deciding",
    "lead_temperature",
    "consultation_type",
    "consultation_type_locked",
    "consult_explained",
    "translator_needed",
    "translator_confirmed",
    "translator_explained",
    "hold_appointment_id",
    "last_sent_slots",
    "times_sent",
    "deposit_link_url",
    "last_seen_fields_snapshot",
  ];

  const normalized = canonicalKeys
    .map((k) => normalizeDisplayName(k))
    .filter(Boolean);

  return new Set(normalized);
}

const ALLOWED_FIELD_KEYS = buildAllowedFieldSet();

/**
 * Extract custom fields from webhook payload (display names or snake_case).
 * More reliable than getContact() array format.
 */
function extractCustomFieldsFromPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return {};

  const customFields = {};

  const maybeStore = (rawKey, value) => {
    const snakeKey = normalizeDisplayName(rawKey);
    if (!snakeKey) return;
    const keep =
      ALLOWED_FIELD_KEYS.has(snakeKey) ||
      snakeKey.includes("tattoo") ||
      snakeKey.includes("deposit") ||
      snakeKey.includes("consult") ||
      snakeKey.includes("translator") ||
      snakeKey.includes("slot") ||
      snakeKey.includes("hold");
    if (keep) {
      customFields[snakeKey] = value;
    }
  };

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === "") continue;

    // Nested object that looks like a custom field payload
    if (typeof value === "object" && !Array.isArray(value)) {
      if (value.value !== undefined) {
        const fieldKey =
          value.key ||
          value.fieldKey ||
          value.customFieldKey ||
          value.customFieldId ||
          value.id ||
          key;
        maybeStore(fieldKey, value.value);
      }
      continue;
    }

    // Array payloads (rare) - attempt to normalize
    if (Array.isArray(value)) {
      const normalized = normalizeCustomFields(value);
      Object.assign(customFields, normalized);
      continue;
    }

    maybeStore(key, value);
  }

  return customFields;
}

/**
 * Merge webhook custom fields into contact and ensure normalized flat shape.
 */
function buildEffectiveContact(contactRaw = {}, payloadCustomFields = {}) {
  const normalizedFromContact = normalizeCustomFields(
    contactRaw.customField || contactRaw.customFields || {}
  );
  const normalizedFromPayload = normalizeCustomFields(payloadCustomFields);

  const mergedCf = { ...normalizedFromContact, ...normalizedFromPayload };

  return {
    ...contactRaw,
    customField: mergedCf,
    customFields: mergedCf,
  };
}

/**
 * Build the contactProfile object passed to the LLM prompts.
 */
function buildContactProfile(
  canonicalState = {},
  { changedFields = {}, derivedPhase = null, intents = {} } = {}
) {
  const lastSeenSnapshot = canonicalState.lastSeenSnapshot || {};

  return {
    tattooPlacement: canonicalState.tattooPlacement || null,
    tattooSummary: canonicalState.tattooSummary || null,
    tattooSize: canonicalState.tattooSize || null,
    tattooSizeNotes: canonicalState.tattooSizeNotes || null,
    timeline: canonicalState.timeline || null,
    consultationType: canonicalState.consultationType || null,
    consultationTypeLocked: !!canonicalState.consultationTypeLocked,
    consultExplained: !!canonicalState.consultExplained,
    translatorNeeded: !!canonicalState.translatorNeeded,
    translatorConfirmed: !!canonicalState.translatorConfirmed,
    languageBarrierExplained: !!canonicalState.languageBarrierExplained,
    depositLinkSent: !!canonicalState.depositLinkSent,
    depositPaid: !!canonicalState.depositPaid,
    lastSeenFieldsSnapshot: lastSeenSnapshot,
    changedFieldsThisTurn: changedFields || {},
    derivedPhase: derivedPhase || null,
    languagePreference: canonicalState.languagePreference || null,
    isReturningClient: !!canonicalState.isReturningClient,
    previousArtistName: canonicalState.previousArtistName || canonicalState.inquiredTechnician || null,
    tattooDescriptionAcknowledged:
      changedFields.tattooSummary !== undefined
        ? true
        : !!lastSeenSnapshot.tattooSummary,
    intents: intents || {},
  };
}

module.exports = {
  normalizeDisplayName,
  normalizeCustomFields,
  extractCustomFieldsFromPayload,
  buildEffectiveContact,
  buildContactProfile,
};

