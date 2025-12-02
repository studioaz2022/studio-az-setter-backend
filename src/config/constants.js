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
  // Booking state fields (persisted for crash recovery)
  TIMES_SENT: "times_sent", // Whether time options have been sent
  DEPOSIT_LINK_URL: "deposit_link_url", // The actual deposit URL for reuse
  PENDING_SLOT_START: "pending_slot_start", // ISO timestamp of pending slot
  PENDING_SLOT_END: "pending_slot_end", // ISO timestamp of pending slot end
  PENDING_SLOT_DISPLAY: "pending_slot_display", // Human-readable slot display
  PENDING_SLOT_ARTIST: "pending_slot_artist", // Artist for pending slot
  PENDING_SLOT_CALENDAR: "pending_slot_calendar", // Calendar ID for pending slot
  PENDING_SLOT_MODE: "pending_slot_mode", // Consult mode (online/in-person)
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
  SIZE_OF_TATTOO: "size_of_tattoo",
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
const CALENDARS = {
  JOAN_IN_PERSON: "99Yu0gxVJ1Cc2y87CTJG",
  JOAN_ONLINE: "Y13HIK8jFgO45zyq4sk7",
  ANDREW_IN_PERSON: "yKJJJoyEZ6j8tZhVgJ5i",
  ANDREW_ONLINE: "yVylpytpJmhu47osg3mN",
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
  JOAN: "1wuLf50VMODExBSJ9xPI",
  ANDREW: "O8ChoMYj1BmMWJJsDlvC",
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
  HOLD_CONFIG,
  APPOINTMENT_STATUS,
  ARTIST_ASSIGNED_USER_IDS,
};

