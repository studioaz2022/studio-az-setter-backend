// constants.js
// Centralized constants for the AI Setter system

// AI Phases
const AI_PHASES = {
  INTAKE: "intake",
  DISCOVERY: "discovery",
  QUALIFICATION: "qualification",
  CLOSING: "closing",
  OBJECTIONS: "objections",
  ROUTING: "routing",
  HANDOFF: "handoff",
  REENGAGEMENT: "reengagement",
  CONSULT_SUPPORT: "consult_support",
  CONSULT_PATH: "consult_path",
  SCHEDULING: "scheduling",
  DEPOSIT_PENDING: "deposit_pending",
  QUALIFIED: "qualified",
  BOOKED: "booked",
  POST_BOOKING_SUPPORT: "post_booking_support",
};

// Lead Temperatures
const LEAD_TEMPERATURES = {
  HOT: "hot",
  WARM: "warm",
  COLD: "cold",
  DISQUALIFIED: "disqualified",
};

// System Field Keys (GHL custom field keys)
const SYSTEM_FIELDS = {
  AI_PHASE: "ai_phase",
  LEAD_TEMPERATURE: "lead_temperature",
  LANGUAGE_PREFERENCE: "language_preference",
  DEPOSIT_LINK_SENT: "deposit_link_sent",
  DEPOSIT_PAID: "deposit_paid",
  SQUARE_PAYMENT_LINK_ID: "square_payment_link_id",
  LAST_PHASE_UPDATE_AT: "last_phase_update_at",
  OPPORTUNITY_ID: "opportunity_id",
  OPPORTUNITY_STAGE: "opportunity_stage",
  CONSULTATION_TYPE: "consultation_type",
  CONSULTATION_TYPE_LOCKED: "consultation_type_locked",
  ASSIGNED_ARTIST: "assigned_artist",
  ARTIST_ASSIGNED_AT: "artist_assigned_at",
  LEAD_SPANISH_COMFORTABLE: "lead_spanish_comfortable",
  TRANSLATOR_NEEDED: "translator_needed",
  TRANSLATOR_CONFIRMED: "translator_confirmed",
  TRANSLATOR_EXPLAINED: "translator_explained",
  TRANSLATOR_APPOINTMENT_ID: "translator_appointment_id",
  RETURNING_CLIENT: "returning_client",
  CLIENT_LIFETIME_VALUE: "client_lifetime_value",
  TOTAL_TATTOOS_COMPLETED: "total_tattoos_completed",
  TATTOO_BOOKED: "tattoo_booked",
  TATTOO_COMPLETED: "tattoo_completed",
  COLD_NURTURE_LOST: "cold_nurture_lost",
  // Booking state fields (persisted for crash recovery)
  TIMES_SENT: "times_sent", // Whether time options have been sent
  DEPOSIT_LINK_URL: "deposit_link_url", // The actual deposit URL for reuse
  PENDING_SLOT_START: "pending_slot_start", // ISO timestamp of pending slot
  PENDING_SLOT_END: "pending_slot_end", // ISO timestamp of pending slot end
  PENDING_SLOT_DISPLAY: "pending_slot_display", // Human-readable slot display
  PENDING_SLOT_ARTIST: "pending_slot_artist", // Artist for pending slot
  PENDING_SLOT_CALENDAR: "pending_slot_calendar", // Calendar ID for pending slot
  PENDING_SLOT_MODE: "pending_slot_mode", // Consult mode (online/in-person)
  CONSULT_EXPLAINED: "consult_explained", // Whether consult process has been explained
  LAST_SENT_SLOTS: "last_sent_slots", // Serialized JSON of last offered slots
  // Live hold tracking fields
  HOLD_APPOINTMENT_ID: "hold_appointment_id", // ID of the tentative (NEW) consult appointment
  HOLD_LAST_ACTIVITY_AT: "hold_last_activity_at", // ISO timestamp of last inbound message
  HOLD_WARNING_SENT: "hold_warning_sent", // true/false flag for 10-min warning
  LAST_RELEASED_SLOT_DISPLAY: "last_released_slot_display", // Last slot that was released
  LAST_RELEASED_SLOT_START: "last_released_slot_start", // Timestamp of released slot
  LAST_RELEASED_SLOT_END: "last_released_slot_end", // End timestamp of released slot
  LAST_SEEN_FIELDS: "last_seen_fields_snapshot",
};

// Tattoo Custom Field Keys
const TATTOO_FIELDS = {
  LANGUAGE_PREFERENCE: "language_preference",
  INQUIRED_TECHNICIAN: "inquired_technician",
  WHATSAPP_USER: "whatsapp_user",
  TATTOO_TITLE: "tattoo_title",
  TATTOO_SUMMARY: "tattoo_summary",
  TATTOO_PLACEMENT: "tattoo_placement",
  TATTOO_STYLE: "tattoo_style",
  // NOTE: CRM canonical key is tattoo_size (was size_of_tattoo historically)
  SIZE_OF_TATTOO: "tattoo_size",
  TATTOO_SIZE_NOTES: "tattoo_size_notes",
  TATTOO_COLOR_PREFERENCE: "tattoo_color_preference",
  HOW_SOON_IS_CLIENT_DECIDING: "how_soon_is_client_deciding",
  FIRST_TATTOO: "first_tattoo",
  TATTOO_CONCERNS: "tattoo_concerns",
  TATTOO_PHOTO_DESCRIPTION: "tattoo_photo_description",
};

// Deposit Configuration
const DEPOSIT_CONFIG = {
  DEFAULT_AMOUNT_CENTS: 10000, // $100.00
  DECOY_AMOUNT_CENTS: 5000, // $50.00 (consult fee, non-refundable)
  DEFAULT_DESCRIPTION: "Studio AZ Tattoo Deposit",
};

// Language Values
const LANGUAGES = {
  ENGLISH: "English",
  SPANISH: "Spanish",
  EN: "en",
  ES: "es",
};

// Tags
const TAGS = {
  CONSULTATION_REQUEST: "consultation request",
  DM_CONSULTATION_REQUEST: "dm consultation request",
  SOURCE_WEB_WIDGET: "Source: Web Widget",
};

// Message Delays (in milliseconds)
const MESSAGE_DELAYS = {
  MIN_DELAY_MS: 800,
  MAX_DELAY_MS: 2000,
  CHARS_PER_SECOND: 50,
};

// Calendar IDs for consult appointments
// TEMP: Using test calendar for troubleshooting (will revert to real calendars later)
const CALENDARS = {
  JOAN_IN_PERSON: "2EJcAtrllnYOtuSx4Dua",
  JOAN_ONLINE: "2EJcAtrllnYOtuSx4Dua",
  ANDREW_IN_PERSON: "2EJcAtrllnYOtuSx4Dua",
  ANDREW_ONLINE: "2EJcAtrllnYOtuSx4Dua",
};

// Translator calendars (hardcoded)
const TRANSLATOR_CALENDARS = {
  LIONEL_IN_PERSON: "qmjQJranj3zQqFqipCl4",
  LIONEL_ONLINE: "wDyotwOVW0fhgwKJGJxc",
  MARIA_IN_PERSON: "mmLWt370a94tbaNQIgNw",
  MARIA_ONLINE: "LMIAfVnFU7phKTXoIuse",
};

const OPPORTUNITY_STAGES = {
  INTAKE: "INTAKE",
  DISCOVERY: "DISCOVERY",
  DEPOSIT_PENDING: "DEPOSIT_PENDING",
  QUALIFIED: "QUALIFIED",
  CONSULT_APPOINTMENT: "CONSULT_APPOINTMENT",
  CONSULT_MESSAGE: "CONSULT_MESSAGE",
  TATTOO_BOOKED: "TATTOO_BOOKED",
  COMPLETED: "COMPLETED",
  COLD_NURTURE_LOST: "COLD_NURTURE_LOST",
};

// Appointment hold configuration
const HOLD_CONFIG = {
  HOLD_MINUTES: 15, // Hold time before releasing slot
  FINAL_REMINDER_MINUTES_BEFORE_EXPIRY: 10, // Send reminder X minutes before hold expires
};

// Appointment status values (per GHL API)
const APPOINTMENT_STATUS = {
  NEW: "new", // Pending / on-hold before deposit
  CONFIRMED: "confirmed", // After deposit paid
  CANCELLED: "cancelled", // Released due to no deposit
  SHOWED: "showed",
  NOSHOW: "noshow",
  INVALID: "invalid",
};

// Assigned user IDs for artists (used when creating GHL appointments)
// These should match the "team member" IDs in GHL
const ARTIST_ASSIGNED_USER_IDS = {
  JOAN: "Wl24x1ZrucHuHatM0ODD",
  ANDREW: "Wl24x1ZrucHuHatM0ODD",
};

const ARTIST_NAME_TO_ID = Object.fromEntries(
  Object.entries(ARTIST_ASSIGNED_USER_IDS || {}).map(([name, id]) => [
    String(name).toLowerCase(),
    id,
  ])
);

// Artist language capabilities (hardcoded)
const ARTIST_LANGUAGES = {
  Joan: { speaks: ["Spanish"], needsTranslatorFor: ["English"] },
  Andrew: { speaks: ["Spanish"], needsTranslatorFor: ["English"] },
};

module.exports = {
  AI_PHASES,
  LEAD_TEMPERATURES,
  SYSTEM_FIELDS,
  TATTOO_FIELDS,
  DEPOSIT_CONFIG,
  LANGUAGES,
  TAGS,
  MESSAGE_DELAYS,
  CALENDARS,
  TRANSLATOR_CALENDARS,
  HOLD_CONFIG,
  APPOINTMENT_STATUS,
  ARTIST_ASSIGNED_USER_IDS,
  ARTIST_NAME_TO_ID,
  ARTIST_LANGUAGES,
  OPPORTUNITY_STAGES,
};
