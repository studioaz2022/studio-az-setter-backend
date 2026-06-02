// tools.js — v2 AI setter tool definitions + handlers (Phase 2).
//
// These replace v1's deterministic branches. The LLM decides WHEN to call them; the
// handlers WRAP existing, battle-tested plumbing (ghlCalendarClient, squareClient,
// ghlClient) rather than reimplementing booking logic.
//
// Two exports matter:
//   TOOL_DEFINITIONS — Anthropic tool schemas passed to the model.
//   executeTool(name, input, ctx) — runs a handler, NEVER throws. Returns a plain object
//     the model sees as the tool_result. ctx carries { contactId, contact, channelContext,
//     language, contactName, dryRun }.
//
// dryRun mode returns realistic canned results WITHOUT touching GHL/Square — used by tests
// to verify tool SELECTION + arg validity with zero side effects (no real holds/links).

const {
  getCalendarFreeSlots,
  createAppointment,
  updateAppointmentStatus,
  rescheduleAppointment,
} = require("../../clients/ghlCalendarClient");
const { createDepositLinkForContact } = require("../../payments/squareClient");
const { updateContact } = require("../../clients/ghlClient");
const { handleHumanHandoff } = require("../../clients/aiSetterEventHandler");
const {
  SYSTEM_FIELDS,
  TATTOO_FIELDS,
  FUNNEL_STATUSES,
  CALENDARS,
  IN_PERSON_CONSULTATION_CALENDARS,
  DEPOSIT_CONFIG,
} = require("../../config/constants");

// Active artists only (Claudia is a test account — excluded). Consult calendars by mode.
const ACTIVE_CONSULT_CALENDARS = {
  online: [
    { artist: "Andrew", calendarId: CALENDARS.ANDREW_ONLINE },
    { artist: "Joan", calendarId: CALENDARS.JOAN_ONLINE },
  ],
  in_person: [
    { artist: "Andrew", calendarId: IN_PERSON_CONSULTATION_CALENDARS.ANDREW_IN_PERSON },
    { artist: "Joan", calendarId: IN_PERSON_CONSULTATION_CALENDARS.JOAN_IN_PERSON },
  ],
};

const SLOT_LOOKAHEAD_DAYS = 14;
const MAX_SLOTS_RETURNED = 5;
const HOLD_MINUTES = 20;

// Friendly tool-arg keys → real GHL custom-field keys (whitelist for update_lead_fields).
const LEAD_FIELD_MAP = {
  placement: TATTOO_FIELDS.TATTOO_PLACEMENT,
  size: TATTOO_FIELDS.SIZE_OF_TATTOO,
  size_notes: TATTOO_FIELDS.TATTOO_SIZE_NOTES,
  style: TATTOO_FIELDS.TATTOO_STYLE,
  color_preference: TATTOO_FIELDS.TATTOO_COLOR_PREFERENCE,
  summary: TATTOO_FIELDS.TATTOO_SUMMARY,
  timeline: TATTOO_FIELDS.HOW_SOON_IS_CLIENT_DECIDING,
  first_tattoo: TATTOO_FIELDS.FIRST_TATTOO,
  concerns: TATTOO_FIELDS.TATTOO_CONCERNS,
  language: SYSTEM_FIELDS.LANGUAGE_PREFERENCE,
  consultation_type: SYSTEM_FIELDS.CONSULTATION_TYPE,
};

// ──────────────────────────────────────────────────────────────────────────────
// Tool schemas (Anthropic format)
// ──────────────────────────────────────────────────────────────────────────────
const TOOL_DEFINITIONS = [
  {
    name: "fetch_available_slots",
    description:
      "Get upcoming consultation time slots. Call when the lead is ready to book or asks about availability. Returns a short list of real openings across the active artists.",
    input_schema: {
      type: "object",
      properties: {
        consult_type: { type: "string", enum: ["online", "in_person"], description: "Video (online) or in-person consult." },
        artist: { type: "string", enum: ["Andrew", "Joan", "any"], description: "Preferred artist, or 'any' to see all." },
      },
      required: ["consult_type"],
    },
  },
  {
    name: "create_hold_with_deposit_link",
    description:
      "Hold a specific consult slot (20-min tentative hold) AND generate the $100 refundable deposit link. Call only after the lead picked a specific time from fetch_available_slots. Pass the exact slot fields you got back.",
    input_schema: {
      type: "object",
      properties: {
        start_time: { type: "string", description: "ISO start time of the chosen slot." },
        end_time: { type: "string", description: "ISO end time of the chosen slot." },
        calendar_id: { type: "string", description: "calendarId of the chosen slot." },
        artist: { type: "string", description: "Artist name for the slot." },
        consult_type: { type: "string", enum: ["online", "in_person"] },
      },
      required: ["start_time", "end_time", "calendar_id"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel the lead's current consult hold/appointment. Use when they want to cancel.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "Appointment id; if omitted, the current hold on file is used." },
        calendar_id: { type: "string" },
      },
    },
  },
  {
    name: "reschedule_appointment",
    description: "Move the lead's consult to a new time. Pass the new slot fields (from fetch_available_slots).",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "Appointment id; if omitted, the current hold on file is used." },
        start_time: { type: "string" },
        end_time: { type: "string" },
        calendar_id: { type: "string" },
      },
      required: ["start_time", "end_time"],
    },
  },
  {
    name: "update_lead_fields",
    description:
      "Save details you learned about the lead (placement, size, style, timeline, language, first_tattoo, etc.) to the CRM. Call whenever you learn something durable.",
    input_schema: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          description: "Map of known keys to values, e.g. {placement:'forearm', style:'fineline', first_tattoo:'yes'}.",
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "send_consult_form_link",
    description: "Send the lead a link to the consultation intake form (for richer details). Optional — offer it, don't force it.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "flag_for_human",
    description:
      "Escalate to a human and pause the bot. Use for anything sensitive, out of scope, or weird. This stops the bot until a human resumes it.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "Short reason for the human." } },
      required: ["reason"],
    },
  },
  {
    name: "schedule_followup",
    description:
      "Schedule a future follow-up if the lead went cold or asked for time. Provide when (e.g. '2 days') and the message to send then.",
    input_schema: {
      type: "object",
      properties: {
        when: { type: "string", description: "When to follow up, e.g. '2 days', '7 days'." },
        message: { type: "string", description: "The drafted reopening message, referencing what they said." },
      },
      required: ["when", "message"],
    },
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function formatSlotDisplay(iso, language = "en") {
  try {
    const d = new Date(iso);
    return d.toLocaleString(language === "es" ? "es-US" : "en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: "America/Chicago",
    });
  } catch {
    return iso;
  }
}

function readHoldId(ctx) {
  const cf = ctx?.contact?.customField || ctx?.contact?.customFields || {};
  return cf[SYSTEM_FIELDS.HOLD_APPOINTMENT_ID] || null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Handlers — each returns a plain object the model sees. Throwing is caught by executeTool.
// ──────────────────────────────────────────────────────────────────────────────
const HANDLERS = {
  async fetch_available_slots(input, ctx) {
    const mode = input.consult_type === "in_person" ? "in_person" : "online";
    const wanted = input.artist && input.artist !== "any" ? input.artist : null;
    const calendars = ACTIVE_CONSULT_CALENDARS[mode].filter((c) => !wanted || c.artist === wanted);
    const start = new Date();
    const end = new Date(Date.now() + SLOT_LOOKAHEAD_DAYS * 86400000);

    const all = [];
    for (const cal of calendars) {
      try {
        const slots = await getCalendarFreeSlots(cal.calendarId, start, end);
        for (const s of slots) all.push({ ...s, artist: cal.artist });
      } catch (err) {
        console.error(`[tool fetch_available_slots] ${cal.artist} failed:`, err.message);
      }
    }
    all.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    const slots = all.slice(0, MAX_SLOTS_RETURNED).map((s) => ({
      start_time: s.startTime,
      end_time: s.endTime,
      calendar_id: s.calendarId,
      artist: s.artist,
      consult_type: mode,
      display: formatSlotDisplay(s.startTime, ctx.language),
    }));
    return { ok: true, count: slots.length, slots };
  },

  async create_hold_with_deposit_link(input, ctx) {
    const { start_time, end_time, calendar_id, artist = null, consult_type = "online" } = input;
    if (!start_time || !end_time || !calendar_id) {
      return { ok: false, error: "start_time, end_time, and calendar_id are required" };
    }
    // 1. Tentative hold (status "new").
    const appt = await createAppointment({
      calendarId: calendar_id,
      contactId: ctx.contactId,
      startTime: start_time,
      endTime: end_time,
      title: "Tattoo Consultation",
      appointmentStatus: "new",
    });
    const holdId = appt?.id || appt?.appointment?.id || appt?.appointmentId || null;

    // 2. $100 refundable deposit link.
    const deposit = await createDepositLinkForContact({
      contactId: ctx.contactId,
      amountCents: DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS,
      paymentType: "deposit",
      language: ctx.language || "en",
      contactName: ctx.contactName || null,
      artistName: artist,
    });

    // 3. Persist booking state (crash-recovery + iOS widgets).
    const display = formatSlotDisplay(start_time, ctx.language);
    await updateContact(ctx.contactId, {
      customField: {
        [SYSTEM_FIELDS.HOLD_APPOINTMENT_ID]: holdId,
        [SYSTEM_FIELDS.PENDING_SLOT_START]: start_time,
        [SYSTEM_FIELDS.PENDING_SLOT_END]: end_time,
        [SYSTEM_FIELDS.PENDING_SLOT_DISPLAY]: display,
        [SYSTEM_FIELDS.PENDING_SLOT_ARTIST]: artist || "",
        [SYSTEM_FIELDS.PENDING_SLOT_CALENDAR]: calendar_id,
        [SYSTEM_FIELDS.PENDING_SLOT_MODE]: consult_type,
        [SYSTEM_FIELDS.DEPOSIT_LINK_URL]: deposit.url,
        [SYSTEM_FIELDS.DEPOSIT_LINK_SENT]: "true",
        [SYSTEM_FIELDS.TIMES_SENT]: "true",
      },
    });

    return {
      ok: true,
      hold_id: holdId,
      deposit_url: deposit.url,
      slot_display: display,
      hold_minutes: HOLD_MINUTES,
    };
  },

  async cancel_appointment(input, ctx) {
    const appointmentId = input.appointment_id || readHoldId(ctx);
    if (!appointmentId) return { ok: false, error: "no appointment id available to cancel" };
    await updateAppointmentStatus(appointmentId, "cancelled", input.calendar_id || null);
    return { ok: true, cancelled_appointment_id: appointmentId };
  },

  async reschedule_appointment(input, ctx) {
    const appointmentId = input.appointment_id || readHoldId(ctx);
    if (!appointmentId) return { ok: false, error: "no appointment id available to reschedule" };
    if (!input.start_time || !input.end_time) return { ok: false, error: "start_time and end_time required" };
    await rescheduleAppointment(appointmentId, {
      startTime: input.start_time,
      endTime: input.end_time,
      calendarId: input.calendar_id || null,
    });
    const display = formatSlotDisplay(input.start_time, ctx.language);
    return { ok: true, rescheduled_appointment_id: appointmentId, new_slot_display: display };
  },

  async update_lead_fields(input, ctx) {
    const fields = input.fields || {};
    const mapped = {};
    const unknown = [];
    for (const [k, v] of Object.entries(fields)) {
      if (LEAD_FIELD_MAP[k]) mapped[LEAD_FIELD_MAP[k]] = v;
      else unknown.push(k);
    }
    if (!Object.keys(mapped).length) return { ok: false, error: "no recognized fields", unknown };
    await updateContact(ctx.contactId, { customField: mapped });
    return { ok: true, saved: Object.keys(mapped).length, ignored: unknown };
  },

  async send_consult_form_link(input, ctx) {
    const url = process.env.CONSULT_FORM_URL || null;
    if (!url) return { ok: false, error: "consult form link not configured (CONSULT_FORM_URL unset)" };
    return { ok: true, form_url: url };
  },

  async flag_for_human(input, ctx) {
    const reason = input.reason || "AI setter requested human help";
    await updateContact(ctx.contactId, {
      customField: { [SYSTEM_FIELDS.FUNNEL_STATUS]: FUNNEL_STATUSES.PAUSED_MANUAL },
    });
    try {
      await handleHumanHandoff(ctx.contactId, { reason, lastAIMessage: ctx.lastAIMessage || null });
    } catch (err) {
      console.error("[tool flag_for_human] notify failed (non-fatal):", err.message);
    }
    return { ok: true, flagged: true, funnel_status: FUNNEL_STATUSES.PAUSED_MANUAL };
  },

  async schedule_followup(input, ctx) {
    // Phase 2 stub: full persistence + cron send lands in Phase 4 (followupScheduler rebuild).
    if (!input.when || !input.message) return { ok: false, error: "when and message required" };
    console.log(`[tool schedule_followup] (stub) contact=${ctx.contactId} when=${input.when} msg="${input.message}"`);
    return { ok: true, scheduled: true, note: "follow-up captured (persistence lands in Phase 4)" };
  },
};

// Canned dry-run results — realistic so the LLM keeps the conversation flowing in tests.
const DRY_RUN = {
  fetch_available_slots: (input) => {
    const mode = input.consult_type === "in_person" ? "in_person" : "online";
    const base = Date.parse("2026-06-05T15:00:00Z");
    const slots = [0, 1, 2].map((i) => {
      const st = new Date(base + i * 86400000).toISOString();
      const et = new Date(base + i * 86400000 + 30 * 60000).toISOString();
      return { start_time: st, end_time: et, calendar_id: "CAL_ANDREW", artist: "Andrew", consult_type: mode, display: formatSlotDisplay(st) };
    });
    return { ok: true, count: slots.length, slots };
  },
  create_hold_with_deposit_link: (input) => ({
    ok: true, hold_id: "HOLD_TEST_123", deposit_url: "https://squareup.com/checkout/TEST", slot_display: formatSlotDisplay(input.start_time), hold_minutes: HOLD_MINUTES,
  }),
  cancel_appointment: (input) => ({ ok: true, cancelled_appointment_id: input.appointment_id || "HOLD_TEST_123" }),
  reschedule_appointment: (input) => ({ ok: true, rescheduled_appointment_id: "HOLD_TEST_123", new_slot_display: formatSlotDisplay(input.start_time) }),
  update_lead_fields: (input) => ({ ok: true, saved: Object.keys(input.fields || {}).length, ignored: [] }),
  send_consult_form_link: () => ({ ok: true, form_url: "https://studioaz.example/consult-form/TEST" }),
  flag_for_human: () => ({ ok: true, flagged: true, funnel_status: FUNNEL_STATUSES.PAUSED_MANUAL }),
  schedule_followup: () => ({ ok: true, scheduled: true, note: "dry-run" }),
};

/**
 * Execute a tool by name. Never throws — returns a plain object for the tool_result.
 * @param {string} name
 * @param {object} input model-provided args
 * @param {object} ctx { contactId, contact, channelContext, language, contactName, dryRun }
 * @returns {Promise<object>}
 */
async function executeTool(name, input = {}, ctx = {}) {
  const handler = HANDLERS[name];
  if (!handler) return { ok: false, error: `unknown tool: ${name}` };
  if (ctx.dryRun) {
    const mock = DRY_RUN[name];
    return mock ? mock(input, ctx) : { ok: true, dryRun: true };
  }
  if (!ctx.contactId) return { ok: false, error: "missing contactId in context" };
  try {
    return await handler(input, ctx);
  } catch (err) {
    console.error(`[tool ${name}] error:`, err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool, HANDLERS, ACTIVE_CONSULT_CALENDARS, LEAD_FIELD_MAP };
