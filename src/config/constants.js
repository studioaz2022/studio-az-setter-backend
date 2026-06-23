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
  LEAD_SOURCE: "lead_source",
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
  // Lost-deal analytics (Refund Request Form §6.6). Auto-captured on every
  // transition to COLD_NURTURE_LOST. Three orthogonal jobs:
  //   LAST_STAGE_BEFORE_LOST — the *when* (where the funnel broke).
  //   LOST_REASON            — the *why* (cause-only, 8 buckets + 'other').
  //   REFUND_TYPE            — the *money outcome* (4 values).
  // Custom fields with these keys must exist in the GHL CRM location. Until
  // they do, writes are silent no-ops — no risk to existing flows.
  LAST_STAGE_BEFORE_LOST: "last_stage_before_lost",
  LOST_REASON: "lost_reason",
  REFUND_TYPE: "refund_type",
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
  // Returning client context
  PREVIOUS_CONVERSATION_SUMMARY: "previous_conversation_summary", // Summarized history from previous tattoo cycles
  LAST_TATTOO_COMPLETED_AT: "last_tattoo_completed_at", // When the last tattoo was completed
  // AI bot version override (Phase 0 — v2 rewrite feature flag)
  AI_BOT_VERSION: "ai_bot_version", // Per-contact override: "v1" or "v2"; falls back to AI_BOT_VERSION env
  // Funnel gate (Phase 0.5 — v2 rewrite) — REQUIRES manual GHL custom-field creation before non-shadow use
  FUNNEL_STATUS: "funnel_status", // Source of truth for v2 routing (see FUNNEL_STATUSES)
  FUNNEL_ENTRY_SOURCE: "funnel_entry_source", // How the lead entered: website_form | sms | dm | unknown
  FUNNEL_ENTRY_DATE: "funnel_entry_date", // ISO timestamp the lead was first classified into the funnel
  HUMAN_LAST_MESSAGE_AT: "human_last_message_at", // ISO timestamp of the most recent human (GHL user) reply — drives paused_human decay
};

// Funnel status values (Phase 0.5). The single source of truth for v2 routing.
// unset (field absent/empty) => brand-new contact => run classifier.
const FUNNEL_STATUSES = {
  ACTIVE: "active", // In funnel, bot drives the conversation (full v2 controller)
  PAUSED_HUMAN: "paused_human", // Human replied recently; bot silent in 24h decay window
  PAUSED_MANUAL: "paused_manual", // iOS toggle paused the bot; silent until manually resumed
  COMPLETED: "completed", // Tattoo done, FAQ mode; re-run classifier on new inbound
  NOT_A_LEAD: "not_a_lead", // Classifier said no; silent forever unless re-classified
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
  // Raw consult-method choice from the web widget (video call vs message-based). See
  // CONSULT_PREFERENCE_VALUES for the value strings the form writes.
  CONSULTATION_PREFERENCE: "consultation_preference",
};

// Consult-method choices the website widget writes into `consultation_preference`.
// "Video Call with Coordinator" / "Video Call with Translator" → live video consult (book a slot).
// "Message-Based Consultation" → async text consult (deposit-only, NO calendar slot).
// The widget never offers in-person, so the v2 bot must not propose it to web-form leads.
const CONSULT_PREFERENCE_VALUES = {
  VIDEO_COORDINATOR: "Video Call with Coordinator",
  VIDEO_TRANSLATOR: "Video Call with Translator",
  MESSAGE_BASED: "Message-Based Consultation",
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
// Artist online consultation calendars
const CALENDARS = {
  JOAN_ONLINE: "Y13HIK8jFgO45zyq4sk7",
  ANDREW_ONLINE: "yVylpytpJmhu47osg3mN",
  CLAUDIA_ONLINE: "6RVbtnlSgXsnv2yG18Bo",
  MEGAN_ONLINE: "bCY1Tl31taMqFwIzwhnQ",
};

// Artist in-person consultation calendars
const IN_PERSON_CONSULTATION_CALENDARS = {
  JOAN_IN_PERSON: "99Yu0gxVJ1Cc2y87CTJG",
  ANDREW_IN_PERSON: "yKJJJoyEZ6j8tZhVgJ5i",
  CLAUDIA_IN_PERSON: "2EJcAtrllnYOtuSx4Dua",
  MEGAN_IN_PERSON: "94BxNphQPoKjdT0qTbZw",
};

// Tattoo appointment calendars (in-person sessions)
const TATTOO_CALENDARS = {
  JOAN_TATTOO: "0oW0C4kLB6qh1qa1WV9c",
  ANDREW_TATTOO: "9KwARaShHhymNjgarXgA",
  CLAUDIA_TATTOO: "Kzfh6YzvT9ck2qknjjJX",
  MEGAN_TATTOO: "V4BBSwT1ItpeAOvurkA0",
};

// Translator calendars (online only)
const TRANSLATOR_CALENDARS = {
  LIONEL_ONLINE: "mmLWt370a94tbaNQIgNw",
  MARIA_ONLINE: "LMIAfVnFU7phKTXoIuse",
};

// All consultation calendars (online + in-person + translator)
// Used to detect consultation_ended events for quote verification
const CONSULTATION_CALENDARS = {
  CLAUDIA_ONLINE: "6RVbtnlSgXsnv2yG18Bo",
  CLAUDIA_IN_PERSON: "2EJcAtrllnYOtuSx4Dua",
  JOAN_ONLINE: "Y13HIK8jFgO45zyq4sk7",
  JOAN_IN_PERSON: "99Yu0gxVJ1Cc2y87CTJG",
  ANDREW_ONLINE: "yVylpytpJmhu47osg3mN",
  ANDREW_IN_PERSON: "yKJJJoyEZ6j8tZhVgJ5i",
  MEGAN_ONLINE: "bCY1Tl31taMqFwIzwhnQ",
  MEGAN_IN_PERSON: "94BxNphQPoKjdT0qTbZw",
};

// GHL User IDs for all team members
const GHL_USER_IDS = {
  CLAUDIA: "Wl24x1ZrucHuHatM0ODD",
  JOAN: "1wuLf50VMODExBSJ9xPI",
  ANDREW: "O8ChoMYj1BmMWJJsDlvC",
  MEGAN: "BaSmQL1fkhdjmCYuDRWK",
  LIONEL: "1kFG5FWdUDhXLUX46snG",
  MARIA: "uAWhIMemqUPJC1SqCyDR",
};

// GHL User emails by userId (for Google Calendar invites)
const GHL_USER_EMAILS = {
  "Wl24x1ZrucHuHatM0ODD": "l.jchavez@hotmail.com",       // Claudia
  "O8ChoMYj1BmMWJJsDlvC": "andrew_fernandez1@icloud.com", // Andrew
  "1wuLf50VMODExBSJ9xPI": "cjoanmartinez73@gmail.com",    // Joan
  "BaSmQL1fkhdjmCYuDRWK": "Mschultz152@gmail.com",         // Megan
  "1kFG5FWdUDhXLUX46snG": "chavezctz@gmail.com",           // Lionel
  "uAWhIMemqUPJC1SqCyDR": "mariaaclaflin@gmail.com",       // Maria
};

// GHL Custom Field IDs for quote-related fields
const GHL_CUSTOM_FIELD_IDS = {
  FINAL_PRICE: "gPilaCtR7j32ACQIwAzk",
  QUOTED: "U4vZ7BVoyw6Zkwq33sj6", // DEPRECATED: read-only fallback. Do not write. Use FINAL_PRICE.
  CLIENT_INFORMED: "w4f5vvG2BXok9JhayjYD",
  LANGUAGE_PREFERENCE: "ETxasC6QlyxRaKU18kbz",
};

// Translator user IDs (for GHL appointment assignment)
const TRANSLATOR_USER_IDS = {
  LIONEL: "1kFG5FWdUDhXLUX46snG",
  MARIA: "uAWhIMemqUPJC1SqCyDR",
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
  JOAN: "1wuLf50VMODExBSJ9xPI",
  ANDREW: "O8ChoMYj1BmMWJJsDlvC",
  MEGAN: "BaSmQL1fkhdjmCYuDRWK",
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
  // ASSUMPTION: Megan is English-speaking. Confirm + adjust if she speaks Spanish.
  Megan: { speaks: ["English"], needsTranslatorFor: ["Spanish"] },
};

module.exports = {
  AI_PHASES,
  LEAD_TEMPERATURES,
  SYSTEM_FIELDS,
  FUNNEL_STATUSES,
  TATTOO_FIELDS,
  CONSULT_PREFERENCE_VALUES,
  DEPOSIT_CONFIG,
  LANGUAGES,
  TAGS,
  MESSAGE_DELAYS,
  CALENDARS,
  IN_PERSON_CONSULTATION_CALENDARS,
  TATTOO_CALENDARS,
  TRANSLATOR_CALENDARS,
  TRANSLATOR_USER_IDS,
  CONSULTATION_CALENDARS,
  GHL_USER_IDS,
  GHL_USER_EMAILS,
  GHL_CUSTOM_FIELD_IDS,
  HOLD_CONFIG,
  APPOINTMENT_STATUS,
  ARTIST_ASSIGNED_USER_IDS,
  ARTIST_NAME_TO_ID,
  ARTIST_LANGUAGES,
  OPPORTUNITY_STAGES,
};
