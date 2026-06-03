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
const { scheduleFollowup } = require("./followupScheduler");
const { isAllowlistedTestPhone } = require("./botVersion");
const { getArtistPreferenceFromContact } = require("../artistRouter");
const {
  SYSTEM_FIELDS,
  TATTOO_FIELDS,
  FUNNEL_STATUSES,
  CALENDARS,
  IN_PERSON_CONSULTATION_CALENDARS,
  GHL_USER_IDS,
  DEPOSIT_CONFIG,
} = require("../../config/constants");

// Per-artist consult calendars + the GHL user id to assign the appointment to, by mode.
// Claudia is the TEST account: real leads never route to her, but the test-phone allowlist
// (AI_BOT_V2_PHONES) does, so end-to-end tests don't clutter Andrew's/Joan's real calendars.
const ARTIST_CONSULT = {
  Andrew: { online: CALENDARS.ANDREW_ONLINE, in_person: IN_PERSON_CONSULTATION_CALENDARS.ANDREW_IN_PERSON, userId: GHL_USER_IDS.ANDREW },
  Joan: { online: CALENDARS.JOAN_ONLINE, in_person: IN_PERSON_CONSULTATION_CALENDARS.JOAN_IN_PERSON, userId: GHL_USER_IDS.JOAN },
  Claudia: { online: CALENDARS.CLAUDIA_ONLINE, in_person: IN_PERSON_CONSULTATION_CALENDARS.CLAUDIA_IN_PERSON, userId: GHL_USER_IDS.CLAUDIA },
};
const ACTIVE_ARTISTS = ["Andrew", "Joan"]; // workload pool when the lead has no specific artist

/** Match an artist string (any case) to a known consult artist key (Andrew/Joan/Claudia), or null. */
function consultArtistKey(name) {
  if (!name) return null;
  const lc = String(name).trim().toLowerCase();
  return Object.keys(ARTIST_CONSULT).find((k) => k.toLowerCase() === lc) || null;
}

/**
 * Which artist calendar(s) to pull/book for this contact.
 *   - test phone  → Claudia's test calendar only (keeps real calendars clean)
 *   - explicit artist requested by the model → that artist
 *   - else → the lead's chosen/assigned artist (inquired_technician / assigned_artist),
 *            falling back to the active workload pool (Andrew + Joan)
 * Returns [{ artist, calendarId, assignedUserId }].
 */
function resolveConsultTargets(ctx, requestedArtist, mode) {
  const m = mode === "in_person" ? "in_person" : "online";
  if (isAllowlistedTestPhone(ctx?.contact)) {
    const c = ARTIST_CONSULT.Claudia;
    return [{ artist: "Claudia", calendarId: c[m], assignedUserId: c.userId }];
  }
  let names;
  const reqKey = consultArtistKey(requestedArtist);
  if (requestedArtist && requestedArtist !== "any" && reqKey) {
    names = [reqKey];
  } else {
    const prefKey = consultArtistKey(getArtistPreferenceFromContact(ctx?.contact));
    names = prefKey && ACTIVE_ARTISTS.includes(prefKey) ? [prefKey] : ACTIVE_ARTISTS;
  }
  return names.map((n) => ({ artist: n, calendarId: ARTIST_CONSULT[n][m], assignedUserId: ARTIST_CONSULT[n].userId }));
}

/** Resolve the GHL user id to assign a hold to (test → Claudia; else artist or calendar match). */
function resolveAssignedUserId(ctx, artist, calendarId) {
  if (isAllowlistedTestPhone(ctx?.contact)) return GHL_USER_IDS.CLAUDIA;
  const key = consultArtistKey(artist);
  if (key) return ARTIST_CONSULT[key].userId;
  for (const c of Object.values(ARTIST_CONSULT)) {
    if (c.online === calendarId || c.in_person === calendarId) return c.userId;
  }
  return null;
}

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
      "Get upcoming consultation time slots. Call when the lead is ready to book or asks about availability. Returns a short list of real openings. IMPORTANT: if the lead stated a day/time preference (e.g. 'next week', 'next Monday', 'after 4pm', 'mornings'), pass it via earliest_date / after_time / before_time so the results actually match — don't offer times that violate what they asked for.",
    input_schema: {
      type: "object",
      properties: {
        consult_type: { type: "string", enum: ["online", "in_person"], description: "Video (online) or in-person consult." },
        artist: { type: "string", enum: ["Andrew", "Joan", "any"], description: "Preferred artist, or 'any' to see all." },
        earliest_date: { type: "string", description: "Optional YYYY-MM-DD. Only return slots ON or AFTER this date. Use the lead's wording + today's date from context (e.g. 'next Monday' → that Monday's date)." },
        after_time: { type: "string", description: "Optional 24h HH:MM (America/Chicago). Only slots at/after this local time. e.g. lead says 'after 4pm' → '16:00'." },
        before_time: { type: "string", description: "Optional 24h HH:MM (America/Chicago). Only slots at/before this local time. e.g. 'before noon' → '12:00'." },
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
    name: "send_deposit_link",
    description:
      "Generate the $100 refundable deposit link WITHOUT booking a calendar time. Use this ONLY for a MESSAGE-BASED (async text) consultation — there's no scheduled call, so the lead just pays the deposit and the consult happens over text. For a VIDEO consult with a specific time, use create_hold_with_deposit_link instead. Never claim a human will send the link — this tool returns the real link for you to send.",
    input_schema: { type: "object", properties: {} },
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

const CHICAGO_TZ = "America/Chicago";

/** Local (America/Chicago) date "YYYY-MM-DD" + minutes-of-day for an ISO instant. */
function localDateParts(iso) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: CHICAGO_TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(iso)).map((p) => [p.type, p.value])
  );
  const hour = parseInt(parts.hour, 10) % 24; // some envs emit "24" for midnight
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutesOfDay: hour * 60 + parseInt(parts.minute, 10) };
}

/** Parse "HH:MM" (24h) → minutes-of-day, or null. */
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Apply the lead's stated date/time constraints to a slot list (each slot has .startTime). */
function filterSlotsByPreference(slots, { earliest_date, after_time, before_time } = {}) {
  const earliest = earliest_date && /^\d{4}-\d{2}-\d{2}$/.test(String(earliest_date).trim()) ? String(earliest_date).trim() : null;
  const afterMin = parseHHMM(after_time);
  const beforeMin = parseHHMM(before_time);
  if (!earliest && afterMin == null && beforeMin == null) return slots;
  return slots.filter((s) => {
    const { date, minutesOfDay } = localDateParts(s.startTime);
    if (earliest && date < earliest) return false;
    if (afterMin != null && minutesOfDay < afterMin) return false;
    if (beforeMin != null && minutesOfDay > beforeMin) return false;
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Handlers — each returns a plain object the model sees. Throwing is caught by executeTool.
// ──────────────────────────────────────────────────────────────────────────────
const HANDLERS = {
  async fetch_available_slots(input, ctx) {
    const mode = input.consult_type === "in_person" ? "in_person" : "online";
    const targets = resolveConsultTargets(ctx, input.artist, mode);
    const start = new Date();
    const end = new Date(Date.now() + SLOT_LOOKAHEAD_DAYS * 86400000);

    const all = [];
    for (const t of targets) {
      try {
        const slots = await getCalendarFreeSlots(t.calendarId, start, end);
        for (const s of slots) all.push({ ...s, artist: t.artist });
      } catch (err) {
        console.error(`[tool fetch_available_slots] ${t.artist} failed:`, err.message);
      }
    }
    const byStart = (a, b) => new Date(a.startTime) - new Date(b.startTime);
    all.sort(byStart);
    // Honor the lead's stated day/time preference (next week / after 4pm / mornings) BEFORE
    // slicing — otherwise we'd only ever return the earliest few and silently ignore what they asked.
    const constrained = !!(input.earliest_date || input.after_time || input.before_time);
    const filtered = filterSlotsByPreference(all, input);
    // If the constraint knocked out everything, fall back to the nearest unfiltered slots but
    // FLAG them as non-matching, so the bot offers them honestly ("nothing in that window — closest is…").
    const noMatch = constrained && all.length > 0 && filtered.length === 0;
    const chosen = noMatch ? all : filtered;
    const slots = chosen.slice(0, MAX_SLOTS_RETURNED).map((s) => ({
      start_time: s.startTime,
      end_time: s.endTime,
      calendar_id: s.calendarId,
      artist: s.artist,
      consult_type: mode,
      display: formatSlotDisplay(s.startTime, ctx.language),
    }));
    return {
      ok: true,
      count: slots.length,
      matched_preference: !noMatch,
      slots,
      ...(noMatch
        ? { note: "NONE of these match the requested day/time window — they're the closest available. Offer them as alternatives honestly ('I don't have anything in that window, the closest is…'); do NOT claim they match what they asked for." }
        : {}),
    };
  },

  async create_hold_with_deposit_link(input, ctx) {
    let { start_time, end_time, calendar_id, artist = null, consult_type = "online" } = input;
    if (!start_time || !end_time) {
      return { ok: false, error: "start_time and end_time are required" };
    }
    // Test phones always book onto Claudia's test calendar, even if the model echoes back a
    // real-artist calendar id from fetch_available_slots — keeps Andrew/Joan calendars clean.
    if (isAllowlistedTestPhone(ctx?.contact)) {
      const m = consult_type === "in_person" ? "in_person" : "online";
      calendar_id = ARTIST_CONSULT.Claudia[m];
      artist = "Claudia";
    }
    if (!calendar_id) return { ok: false, error: "calendar_id is required" };
    const assignedUserId = resolveAssignedUserId(ctx, artist, calendar_id);
    // 1. Tentative hold (status "new").
    const appt = await createAppointment({
      calendarId: calendar_id,
      contactId: ctx.contactId,
      startTime: start_time,
      endTime: end_time,
      title: "Tattoo Consultation",
      appointmentStatus: "new",
      assignedUserId,
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

  async send_deposit_link(input, ctx) {
    // Deposit-only path for message-based (async) consults — no calendar slot/hold.
    const deposit = await createDepositLinkForContact({
      contactId: ctx.contactId,
      amountCents: DEPOSIT_CONFIG.DEFAULT_AMOUNT_CENTS,
      paymentType: "deposit",
      language: ctx.language || "en",
      contactName: ctx.contactName || null,
      artistName: null,
    });
    await updateContact(ctx.contactId, {
      customField: {
        [SYSTEM_FIELDS.DEPOSIT_LINK_URL]: deposit.url,
        [SYSTEM_FIELDS.DEPOSIT_LINK_SENT]: "true",
        [SYSTEM_FIELDS.PENDING_SLOT_MODE]: "message",
      },
    });
    return { ok: true, deposit_url: deposit.url, consult_mode: "message" };
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
    // Follow-up feature is gated off until cadence/rules are reviewed (see AI_SETTER_REWRITE_PLAN).
    if (process.env.AI_FOLLOWUPS_ENABLED !== "true") {
      return { ok: false, error: "follow-ups are disabled", note: "AI_FOLLOWUPS_ENABLED is off" };
    }
    if (!input.when || !input.message) return { ok: false, error: "when and message required" };
    const res = await scheduleFollowup({
      contactId: ctx.contactId,
      when: input.when,
      message: input.message,
      reason: input.reason || "lead went cold / asked for time",
      model: ctx.modelUsed || null,
    });
    // Graceful: until the scheduled_followups table is applied, this no-ops but doesn't break chat.
    if (!res.ok) return { ok: false, error: res.error, note: "follow-up not persisted (table pending)" };
    return { ok: true, scheduled: true, scheduled_for: res.scheduledFor };
  },
};

// Canned dry-run results — realistic so the LLM keeps the conversation flowing in tests.
const DRY_RUN = {
  fetch_available_slots: (input) => {
    const mode = input.consult_type === "in_person" ? "in_person" : "online";
    // Echo the requested artist so dry-run fidelity matches production routing (the real
    // handler returns the lead's artist via resolveConsultTargets, not a hardcoded one).
    const artist = input.artist && input.artist !== "any" ? input.artist : "Joan";
    const base = Date.parse("2026-06-05T15:00:00Z"); // 10:00 AM America/Chicago
    const raw = [0, 1, 2].map((i) => {
      const st = new Date(base + i * 86400000).toISOString();
      const et = new Date(base + i * 86400000 + 30 * 60000).toISOString();
      return { startTime: st, endTime: et, calendarId: `CAL_${artist.toUpperCase()}`, artist };
    });
    const constrained = !!(input.earliest_date || input.after_time || input.before_time);
    const filtered = filterSlotsByPreference(raw, input);
    const noMatch = constrained && filtered.length === 0;
    const chosen = noMatch ? raw : filtered;
    const slots = chosen.map((s) => ({ start_time: s.startTime, end_time: s.endTime, calendar_id: s.calendarId, artist: s.artist, consult_type: mode, display: formatSlotDisplay(s.startTime) }));
    return { ok: true, count: slots.length, matched_preference: !noMatch, slots, ...(noMatch ? { note: "no slots match the requested window; nearest alternatives shown." } : {}) };
  },
  create_hold_with_deposit_link: (input) => ({
    ok: true, hold_id: "HOLD_TEST_123", deposit_url: "https://squareup.com/checkout/TEST", slot_display: formatSlotDisplay(input.start_time), hold_minutes: HOLD_MINUTES,
  }),
  send_deposit_link: () => ({ ok: true, deposit_url: "https://squareup.com/checkout/TEST", consult_mode: "message" }),
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

/**
 * Tool definitions the bot is actually offered, honoring feature flags.
 * schedule_followup is excluded unless AI_FOLLOWUPS_ENABLED="true" (follow-up feature is
 * deferred pending cadence/rules review — so the bot doesn't create dormant follow-up rows).
 */
function getActiveToolDefinitions() {
  const followupsOn = process.env.AI_FOLLOWUPS_ENABLED === "true";
  return TOOL_DEFINITIONS.filter((t) => followupsOn || t.name !== "schedule_followup");
}

module.exports = { TOOL_DEFINITIONS, getActiveToolDefinitions, executeTool, HANDLERS, ARTIST_CONSULT, resolveConsultTargets, LEAD_FIELD_MAP };
