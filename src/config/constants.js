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

module.exports = {
  AI_PHASES,
  LEAD_TEMPERATURES,
  SYSTEM_FIELDS,
  TATTOO_FIELDS,
  DEPOSIT_CONFIG,
  LANGUAGES,
  TAGS,
  MESSAGE_DELAYS,
};

