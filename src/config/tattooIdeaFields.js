// ============================================================================
// Canonical tattoo custom-field map — SINGLE SOURCE OF TRUTH
// (TATTOO_PROJECT_HISTORY_PLAN.md §4 / §10 Phase 0)
//
// Every widget-key → GHL-field-ID mapping for the tattoo location lives here.
// ghlClient.js (CUSTOM_FIELD_MAP) and the fill-flow submit handler both derive
// from this module — do NOT keep private copies of these IDs anywhere else.
// A previous private copy in app.js (FILL_GHL_FIELD_IDS) drifted and wrote
// first_tattoo to the whatsapp_user field and tattoo_photo_description to the
// Photo Reference FILE_UPLOAD field (which can nuke every field in the payload).
// ============================================================================

const TATTOO_FIELD_IDS = {
  language_preference: "ETxasC6QlyxRaKU18kbz",
  inquired_technician: "H3PSN8tZSw1kYckHJN9D",
  whatsapp_user: "QqDydmY1fnldidlcMnBC",
  tattoo_title: "8JqgdVJraABsqgUeqJ3a",
  tattoo_summary: "xAGtMfmbxtfCHdo2oyf7",
  tattoo_placement: "jd8YhvKsBi4aGqjqOEOv",
  tattoo_style: "12b2O4ydlfO99FA4yCuk",
  tattoo_size: "KXtfZYdeSKUyS5llTKsr",
  tattoo_color_preference: "SzyropMDMcitUDhhb8dd",
  how_soon_is_client_deciding: "ra4Nk80WMA8EQkLCfXST",
  first_tattoo: "FnYDobmYqnXDxlLJY5oe",
  tattoo_concerns: "6pvXL4oJVkD1yL4uw8KB",
  budget_range: "8onn1kDyobzZUP1dR7Q9",
  tattoo_photo_description: "vmE7glOhOfrSu5rDrjAA",
  consultation_type: "gM2PVo90yNBDHekV5G64",
  // Raw consult-method choice from the widget (Video Call w/ Coordinator | Translator,
  // or Message-Based Consultation). Stored so the v2 bot doesn't re-ask. Created 2026-06-03.
  consultation_preference: "Rr8j1rOdJHN7FrRFvxvi",
  // Design readiness: "Reference Ready" | "Semi-Custom" | "Fully Custom". Drives
  // turnaround expectations + AI-setter pacing. Created 2026-07-14.
  design_readiness: "Oahqu85KqgDePSImXOlN",
};

// The "idea field group" — the fields that together describe ONE tattoo project.
// This exact set is what gets snapshotted to Supabase tattoo_projects and then
// cleared as a unit (completion reset + new-idea reset). Money fields (Final
// Price, deposits) and the reference-photo FILE_UPLOAD are snapshotted too but
// handled separately — the FILE_UPLOAD field must NEVER be written with "".
const IDEA_FIELD_KEYS = [
  "tattoo_title",
  "tattoo_summary",
  "tattoo_placement",
  "tattoo_style",
  "tattoo_size",
  "tattoo_color_preference",
  "budget_range",
  "how_soon_is_client_deciding",
  "first_tattoo",
  "tattoo_concerns",
  "tattoo_photo_description",
  "design_readiness",
  "consultation_preference",
];

const IDEA_FIELD_IDS = Object.fromEntries(
  IDEA_FIELD_KEYS.map((key) => [key, TATTOO_FIELD_IDS[key]])
);

// Money/quote fields — part of the per-project snapshot, cleared only on a
// confirmed new-idea reset (never mid-session). Final Price is the financial
// reconciliation source of truth (quote-persist architecture).
const FINAL_PRICE_FIELD_ID = "gPilaCtR7j32ACQIwAzk";
const QUOTE_TO_CLIENT_FIELD_ID = "U4vZ7BVoyw6Zkwq33sj6"; // deprecated, read-only
const DEPOSIT_PAID_FIELD_ID = "LCPRivytWsFFTOa5fbXY";
const DEPOSIT_AMOUNT_FIELD_ID = "PLN5t5T47SC5PnLrhmgB"; // key: last_deposit_amount_usd

// Reference photos FILE_UPLOAD (key: tattoo_ideasreferences). Snapshot its URLs;
// NEVER write "" to it — a bad write to a FILE_UPLOAD field drops every field
// in the same update payload (ghl_invalid_url_gotcha).
const PHOTO_REFERENCE_FIELD_ID = "ptrJy8TBBjlnRWQepdnP";

module.exports = {
  TATTOO_FIELD_IDS,
  IDEA_FIELD_KEYS,
  IDEA_FIELD_IDS,
  FINAL_PRICE_FIELD_ID,
  QUOTE_TO_CLIENT_FIELD_ID,
  DEPOSIT_PAID_FIELD_ID,
  DEPOSIT_AMOUNT_FIELD_ID,
  PHOTO_REFERENCE_FIELD_ID,
};
