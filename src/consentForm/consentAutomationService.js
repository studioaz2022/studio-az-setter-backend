// consentAutomationService.js
// Consent form automation — 24h pre-appointment sweep.
//
// Every hour we look at tattoo appointments starting in the next 24 hours. For
// each one:
//   • consent form already on file for that appointment → do nothing
//   • quote + placement filled on the GHL contact       → auto-send the form
//   • either field missing                              → create a Command
//     Center task for the artist (iOS, not GHL) and keep watching
//
// The artist's task completes by SENDING: the sheet's one button calls
// fillAndSend() below, which writes the fields to GHL, sends the form, and
// closes the task in a single call.
//
// Idempotency lives in the consent_automation table, never in memory — a
// deploy mid-sweep must not be able to double-text a client.

const crypto = require("crypto");
const { supabase } = require("../clients/supabaseClient");
const { getContact, updateContact } = require("../clients/ghlClient");
const { fetchAppointmentsForDateRange } = require("../clients/ghlCalendarClient");
const { sendConsentForm, GHL_FIELD_IDS } = require("./consentFormService");
const { sendPushToGhlUser } = require("../services/taskNotifications");
const {
  TATTOO_CALENDARS,
  ARTIST_ASSIGNED_USER_IDS,
  GHL_CUSTOM_FIELD_IDS,
} = require("../config/constants");

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Kill switch. Set CONSENT_AUTOMATION_ENABLED=0 on Render to stop the sweep
// dead without a revert or redeploy of code — it texts real clients, so there
// needs to be a way to pause it from the dashboard.
const AUTOMATION_ENABLED = process.env.CONSENT_AUTOMATION_ENABLED !== "0";

// Log-only mode for pre-flight verification: decisions are computed and printed
// but nothing is sent, inserted, or updated.
const DRY_RUN = process.env.CONSENT_AUTOMATION_DRY_RUN === "1";

// DEPLOY ORDER GUARD — leave this off until the iOS build that knows the
// `consent_fields_needed` task type is on artists' phones.
//
// command_center_tasks rows are decoded as one array by the app; older builds
// parse `type` into a strict enum, so a single unrecognized row throws and the
// artist's Command Center comes up empty — not one missing task, all of them.
// Auto-send runs regardless of this flag; only task creation is gated.
const TASKS_ENABLED = process.env.CONSENT_AUTOMATION_TASKS_ENABLED === "1";

// Look-ahead window. An appointment enters the sweep on the first tick after it
// crosses this boundary, so with hourly ticks every appointment is picked up
// 23–24h before it starts. Overridable for verification runs.
const WINDOW_HOURS = parseInt(process.env.CONSENT_AUTOMATION_WINDOW_HOURS || "24", 10);

const MAX_SEND_ATTEMPTS = 3;

// Quiet hours (Central). Sweep-initiated sends that land outside 9am–9pm are
// held until the next 9am so we never text a client late at night. Artist-
// initiated sends (the task sheet) are never held — that's a deliberate action.
const QUIET_START_HOUR = 21; // 9pm
const QUIET_END_HOUR = 9; // 9am

const TATTOO_CALENDAR_IDS = new Set(Object.values(TATTOO_CALENDARS));

// Calendar ID → artist first name. TATTOO_CALENDARS keys look like "JOAN_TATTOO".
const CALENDAR_TO_ARTIST = Object.fromEntries(
  Object.entries(TATTOO_CALENDARS).map(([key, id]) => [
    id,
    key.replace(/_TATTOO$/, "").toLowerCase().replace(/^./, (c) => c.toUpperCase()),
  ])
);

// Appointment statuses that mean "this isn't happening" — never chase consent.
const DEAD_STATUSES = new Set(["cancelled", "canceled", "noshow", "no_show", "invalid"]);

// The two gate fields, read by GHL field ID. contact.customField is keyed by
// field ID (verified 2026-07-26 — the field-KEY reads elsewhere in this repo are
// dead code that always returns undefined), so ID is the only reliable path.
const FIELD_IDS = {
  finalPrice: GHL_CUSTOM_FIELD_IDS.FINAL_PRICE, // gPilaCtR7j32ACQIwAzk
  tattooPlacement: "jd8YhvKsBi4aGqjqOEOv",
};

// Field-key fallbacks, in case a future GHL/SDK change starts keying by key.
const FIELD_KEYS = {
  finalPrice: "final_price",
  tattooPlacement: "tattoo_placement",
};

// ─── small helpers ────────────────────────────────────────────────────

/** Read a custom field by ID, falling back to field key. */
function readCustomField(contact, which) {
  const cf = contact?.customField || {};
  const byId = cf[FIELD_IDS[which]];
  if (byId !== undefined && byId !== null && byId !== "") return byId;
  const byKey = cf[FIELD_KEYS[which]];
  if (byKey !== undefined && byKey !== null && byKey !== "") return byKey;
  return null;
}

/** Parse a quote into a positive number, or null. */
function parseQuote(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanText(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

/**
 * Format a Date as YYYY-MM-DD in Central time.
 * Never use toISOString() for this — a 7pm CST appointment is already
 * "tomorrow" in UTC, which would stamp the wrong procedure date on the form.
 */
function centralDateString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Human-friendly appointment label in Central time, e.g. "Jul 27 at 2:00 PM". */
function centralDisplay(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** Current hour (0–23) in Central time. */
function centralHour(date) {
  return parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      hour12: false,
    }).format(date),
    10
  );
}

function isQuietHour(date) {
  const h = centralHour(date);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/**
 * Next 9am Central as a Date. Used to hold late-night sends.
 * Returns null if holding would push the send past the appointment itself —
 * in that case sending now beats not sending at all.
 */
function nextQuietWindowEnd(now, appointmentStart) {
  const hour = centralHour(now);
  const dayOffset = hour < QUIET_END_HOUR ? 0 : 1;
  // Build "today/tomorrow at 9am Central" by walking from the current instant.
  const target = new Date(now.getTime() + dayOffset * 24 * 3600 * 1000);
  const dateStr = centralDateString(target);
  // Central is UTC-5 (CDT) or UTC-6 (CST); resolve by probing the offset.
  const probe = new Date(`${dateStr}T${String(QUIET_END_HOUR).padStart(2, "0")}:00:00Z`);
  const offsetMinutes = getCentralOffsetMinutes(probe);
  const holdUntil = new Date(probe.getTime() - offsetMinutes * 60 * 1000);
  if (appointmentStart && holdUntil >= appointmentStart) return null;
  return holdUntil;
}

/** Central UTC offset in minutes for a given instant (−300 CDT / −360 CST). */
function getCentralOffsetMinutes(date) {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const central = new Date(date.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  return Math.round((central.getTime() - utc.getTime()) / 60000);
}

function normalizeStatus(event) {
  return String(
    event.appointmentStatus || event.appoinmentStatus || event.status || "new"
  ).toLowerCase();
}

function artistNameForEvent(event) {
  return CALENDAR_TO_ARTIST[event.calendarId] || null;
}

function artistUserIdFor(artistName, event) {
  const fromMap = artistName
    ? ARTIST_ASSIGNED_USER_IDS[artistName.toUpperCase()]
    : null;
  return fromMap || event.assignedUserId || event.userId || null;
}

// ─── automation row helpers ───────────────────────────────────────────

async function getAutomationRow(appointmentId) {
  const { data } = await supabase
    .from("consent_automation")
    .select("*")
    .eq("appointment_id", appointmentId)
    .maybeSingle();
  return data || null;
}

async function upsertAutomationRow(row) {
  if (DRY_RUN) return { data: row, error: null };
  return supabase
    .from("consent_automation")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "appointment_id" })
    .select()
    .maybeSingle();
}

async function patchAutomationRow(appointmentId, patch) {
  if (DRY_RUN) return { error: null };
  return supabase
    .from("consent_automation")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("appointment_id", appointmentId);
}

/**
 * Does a consent form already exist for this appointment?
 *
 * Matches on appointment_id first. Manual sends from the contact profile or the
 * dashboard quick action don't always carry an appointmentId, so we also accept
 * a live form whose procedure date equals this appointment's date — belt and
 * braces against double-texting after a manual send.
 */
async function consentFormOnFile(contactId, appointmentId, procedureDate) {
  const { data, error } = await supabase
    .from("consent_forms")
    .select("id, appointment_id, date_of_procedure, status")
    .eq("contact_id", contactId)
    .is("expired_at", null)
    .in("status", ["sent", "completed"]);

  if (error) {
    // Fail closed: if we can't tell, don't send. The day-of reminder is the net.
    console.error("❌ [Consent Automation] consent_forms lookup failed:", error.message);
    return true;
  }

  return (data || []).some(
    (f) =>
      (appointmentId && f.appointment_id === appointmentId) ||
      (procedureDate && f.date_of_procedure === procedureDate)
  );
}

// ─── Command Center task (Supabase, iOS-owned table) ──────────────────

const CC_TASK_TYPE = "consent_fields_needed";
const SUPERSEDED_TASK_TYPES = ["consent_form_needed"];
const OPEN_TASK_STATUSES = ["pending", "overdue", "urgent"];

function missingFieldLabels(missing) {
  return missing.map((m) => (m === "final_price" ? "quote" : "placement"));
}

/**
 * Create the Command Center task that asks the artist for the missing fields.
 * Writes straight into command_center_tasks (the same table iOS reads/writes)
 * in the exact snake_case shape CommandCenterTask.CodingKeys expects.
 */
async function createFieldsNeededTask({
  contactId,
  contactName,
  artistUserId,
  appointmentId,
  appointmentStart,
  missing,
}) {
  const labels = missingFieldLabels(missing);
  const apptDisplay = centralDisplay(appointmentStart);
  const now = new Date();

  // Due before the appointment, but never more than 6h out.
  const sixHours = new Date(now.getTime() + 6 * 3600 * 1000);
  const twoHoursBeforeAppt = new Date(appointmentStart.getTime() - 2 * 3600 * 1000);
  const dueAt = new Date(Math.min(sixHours.getTime(), Math.max(twoHoursBeforeAppt.getTime(), now.getTime() + 15 * 60 * 1000)));

  if (!TASKS_ENABLED) {
    console.log(
      `⏸️ [Consent Automation] Task creation disabled (CONSENT_AUTOMATION_TASKS_ENABLED≠1) — ` +
        `would have asked ${artistUserId || "unassigned"} for ${labels.join(" + ")} on ${contactName}`
    );
    return null;
  }

  const taskId = crypto.randomUUID();

  const row = {
    id: taskId,
    type: CC_TASK_TYPE,
    contact_id: contactId,
    contact_name: contactName,
    assigned_to: artistUserId ? [artistUserId] : [],
    created_by: "automation",
    created_at: now.toISOString(),
    due_at: dueAt.toISOString(),
    status: "pending",
    urgency_level: "normal",
    trigger_event: "consent_automation_t24_fields_missing",
    related_appointment_id: appointmentId,
    requires_all_assignees: false,
    metadata: {
      missing_fields: missing.join(","),
      appointment_date: apptDisplay,
      subtitle: `Appointment ${apptDisplay} — add ${labels.join(" + ")} to send the consent form`,
    },
    location_id: GHL_LOCATION_ID,
  };

  if (DRY_RUN) {
    console.log(`🧪 [DRY RUN] would create CC task for ${contactName}: missing ${labels.join(", ")}`);
    return taskId;
  }

  const { error } = await supabase.from("command_center_tasks").insert(row);
  if (error) {
    console.error("❌ [Consent Automation] Failed to insert CC task:", error.message);
    return null;
  }

  // Supersede the generic "send consent form" task iOS may have created for the
  // same contact — ours is strictly more specific and actionable.
  await completeOpenTasks({
    contactId,
    types: SUPERSEDED_TASK_TYPES,
    completedBy: "automation",
  });

  await sendPushToGhlUser(artistUserId, (language) => {
    const isSpanish = language === "es";
    return {
      type: "task_assigned",
      title: isSpanish ? "Faltan datos del tatuaje" : "Tattoo details needed",
      body: isSpanish
        ? `${contactName} — cita ${apptDisplay}. Agrega ${labels.join(" + ")} para enviar el consentimiento.`
        : `${contactName} — appt ${apptDisplay}. Add ${labels.join(" + ")} to send the consent form.`,
      contactId,
      taskId,
    };
  });

  return taskId;
}

/** Mark open Command Center tasks of the given types complete for a contact. */
async function completeOpenTasks({ contactId, types, completedBy, taskId = null }) {
  if (DRY_RUN) return;
  let query = supabase
    .from("command_center_tasks")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: completedBy,
    })
    .eq("contact_id", contactId)
    .in("status", OPEN_TASK_STATUSES);

  if (taskId) query = query.eq("id", taskId);
  else query = query.in("type", types);

  const { error } = await query;
  if (error) {
    console.error("❌ [Consent Automation] Failed to complete CC tasks:", error.message);
  }
}

// ─── the send path ────────────────────────────────────────────────────

/**
 * Claim the row, then send. The claim write happens BEFORE the SMS so a crash
 * or redeploy can never replay the send; if the claim fails we do not send.
 *
 * @returns {{ sent: boolean, error?: string, formUrl?: string }}
 */
async function claimAndSend({
  row,
  contactId,
  appointmentId,
  quotedPrice,
  tattooPlacement,
  numberOfSessions,
  artistName,
  procedureDate,
  via,
}) {
  if (DRY_RUN) {
    console.log(
      `🧪 [DRY RUN] would send consent form → contact ${contactId}, $${quotedPrice}, "${tattooPlacement}", ${procedureDate}`
    );
    return { sent: true };
  }

  const attempt = (row?.attempt_count || 0) + 1;

  const { error: claimError } = await supabase
    .from("consent_automation")
    .update({
      state: "sending",
      sent_claimed_at: new Date().toISOString(),
      attempt_count: attempt,
      updated_at: new Date().toISOString(),
    })
    .eq("appointment_id", appointmentId);

  if (claimError) {
    // Fail closed — an unclaimed send is a send we can't guarantee is unique.
    console.error(`❌ [Consent Automation] Claim failed for ${appointmentId}, not sending:`, claimError.message);
    return { sent: false, error: `claim failed: ${claimError.message}` };
  }

  const result = await sendConsentForm({
    contactId,
    quotedPrice,
    numberOfSessions: numberOfSessions || 1,
    assignedTechnician: artistName || undefined,
    procedureDate,
    tattooPlacement,
    appointmentId,
  });

  if (!result.success) {
    const abandoned = attempt >= MAX_SEND_ATTEMPTS;
    await patchAutomationRow(appointmentId, {
      state: abandoned ? "send_abandoned" : "send_failed",
      last_error: result.error || "unknown send error",
    });
    console.error(
      `❌ [Consent Automation] Send failed (attempt ${attempt}/${MAX_SEND_ATTEMPTS}) for ${contactId}: ${result.error}`
    );
    return { sent: false, error: result.error };
  }

  await patchAutomationRow(appointmentId, {
    state: "sent",
    sent_at: new Date().toISOString(),
    sent_via: via,
    last_error: null,
  });

  return { sent: true, formUrl: result.formUrl };
}

// ─── the sweep ────────────────────────────────────────────────────────

/**
 * Run one pass over the next 24 hours of tattoo appointments.
 * Safe to run repeatedly — every branch is idempotent.
 *
 * @returns {{ success: boolean, appointments, sent, tasksCreated, skipped, errors }}
 */
async function runConsentAutomationSweep() {
  const stats = { appointments: 0, sent: 0, tasksCreated: 0, skipped: 0, errors: 0, held: 0 };

  if (!AUTOMATION_ENABLED) {
    console.log("⏸️ [Consent Automation] Disabled via CONSENT_AUTOMATION_ENABLED=0 — sweep skipped");
    return { success: true, disabled: true, ...stats };
  }

  if (!supabase) {
    console.warn("⚠️ [Consent Automation] Supabase not configured — sweep skipped");
    return { success: false, error: "supabase not configured", ...stats };
  }

  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + WINDOW_HOURS * 3600 * 1000);

    // GHL rejects location-wide event queries, so fetch per tattoo calendar.
    // Five small calls an hour — cheaper than it looks, and precisely scoped.
    const events = [];
    for (const calendarId of TATTOO_CALENDAR_IDS) {
      try {
        const calendarEvents = await fetchAppointmentsForDateRange({
          locationId: GHL_LOCATION_ID,
          startTime: now.getTime(),
          endTime: windowEnd.getTime(),
          calendarId,
        });
        events.push(...(calendarEvents || []));
      } catch (err) {
        // One artist's calendar failing must not blank the whole sweep.
        stats.errors++;
        console.error(
          `❌ [Consent Automation] Calendar ${calendarId} fetch failed:`,
          err.message
        );
      }
    }

    const tattooEvents = events.filter(
      (e) =>
        TATTOO_CALENDAR_IDS.has(e.calendarId) &&
        !DEAD_STATUSES.has(normalizeStatus(e)) &&
        (e.contactId || e.contact?.id)
    );

    stats.appointments = tattooEvents.length;

    for (const event of tattooEvents) {
      try {
        await processAppointment(event, stats);
      } catch (err) {
        stats.errors++;
        console.error(
          `❌ [Consent Automation] Error on appointment ${event.id}:`,
          err.message
        );
      }
    }

    // Close out tasks whose appointment has since been cancelled.
    await closeCancelledAppointments(events, stats);

    console.log(
      `🧾 [Consent Automation] sweep: ${stats.appointments} appts, ${stats.sent} sent, ` +
        `${stats.tasksCreated} tasks, ${stats.held} held, ${stats.skipped} skipped, ${stats.errors} errors` +
        (DRY_RUN ? " (DRY RUN)" : "")
    );

    return { success: true, ...stats };
  } catch (err) {
    console.error("❌ [Consent Automation] Sweep failed:", err.message);
    return { success: false, error: err.message, ...stats };
  }
}

async function processAppointment(event, stats) {
  const appointmentId = event.id;
  const contactId = event.contactId || event.contact?.id;
  const appointmentStart = new Date(event.startTime);
  const procedureDate = centralDateString(appointmentStart);
  const artistName = artistNameForEvent(event);
  const artistUserId = artistUserIdFor(artistName, event);

  const row = await getAutomationRow(appointmentId);

  // Terminal states — nothing more to do.
  if (row && ["sent", "sending", "skipped_has_form", "send_abandoned"].includes(row.state)) {
    stats.skipped++;
    return;
  }

  // A form already on file (manual send, earlier sweep, or a prior tick).
  if (await consentFormOnFile(contactId, appointmentId, procedureDate)) {
    await upsertAutomationRow({
      appointment_id: appointmentId,
      contact_id: contactId,
      calendar_id: event.calendarId,
      artist_name: artistName,
      artist_ghl_user_id: artistUserId,
      appointment_start: appointmentStart.toISOString(),
      state: "skipped_has_form",
    });
    // If the artist got a fields task earlier and the form has since gone out
    // by another route, close the task.
    if (row?.cc_task_id) {
      await completeOpenTasks({
        contactId,
        types: [CC_TASK_TYPE],
        completedBy: "automation",
        taskId: row.cc_task_id,
      });
    }
    stats.skipped++;
    return;
  }

  const contact = await getContact(contactId);
  if (!contact) {
    stats.errors++;
    console.warn(`⚠️ [Consent Automation] Contact ${contactId} not found in GHL`);
    return;
  }

  const contactName =
    [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() ||
    contact.name ||
    event.title ||
    "Client";

  const quotedPrice = parseQuote(readCustomField(contact, "finalPrice"));
  const tattooPlacement = cleanText(readCustomField(contact, "tattooPlacement"));

  const missing = [];
  if (!quotedPrice) missing.push("final_price");
  if (!tattooPlacement) missing.push("tattoo_placement");

  const baseRow = {
    appointment_id: appointmentId,
    contact_id: contactId,
    calendar_id: event.calendarId,
    artist_name: artistName,
    artist_ghl_user_id: artistUserId,
    appointment_start: appointmentStart.toISOString(),
    missing_fields: missing,
  };

  // ── Fields complete → auto-send ──
  if (missing.length === 0) {
    if (!contact.phone) {
      await upsertAutomationRow({ ...baseRow, state: "skipped_no_phone" });
      if (!row?.cc_task_id) {
        const taskId = await createFieldsNeededTask({
          contactId,
          contactName,
          artistUserId,
          appointmentId,
          appointmentStart,
          missing: ["no_phone"],
        });
        if (taskId) {
          await patchAutomationRow(appointmentId, {
            cc_task_id: taskId,
            task_created_at: new Date().toISOString(),
          });
          stats.tasksCreated++;
        }
      }
      return;
    }

    // Quiet-hours hold for sweep-initiated sends only.
    const holdUntil = isQuietHour(new Date())
      ? nextQuietWindowEnd(new Date(), appointmentStart)
      : null;
    if (holdUntil && (!row?.hold_until || new Date(row.hold_until) > new Date())) {
      await upsertAutomationRow({
        ...baseRow,
        state: "pending",
        hold_until: holdUntil.toISOString(),
      });
      stats.held++;
      console.log(
        `🌙 [Consent Automation] Holding send for ${contactName} until ${holdUntil.toISOString()} (quiet hours)`
      );
      return;
    }

    await upsertAutomationRow({ ...baseRow, state: row?.state || "pending" });

    const fresh = await getAutomationRow(appointmentId);
    const result = await claimAndSend({
      row: fresh,
      contactId,
      appointmentId,
      quotedPrice,
      tattooPlacement,
      numberOfSessions: 1,
      artistName,
      procedureDate,
      via: "sweep",
    });

    if (result.sent) {
      stats.sent++;
      // Close the fields task if one was open — the form is out.
      if (row?.cc_task_id) {
        await completeOpenTasks({
          contactId,
          types: [CC_TASK_TYPE],
          completedBy: "automation",
          taskId: row.cc_task_id,
        });
      }
      await completeOpenTasks({
        contactId,
        types: SUPERSEDED_TASK_TYPES,
        completedBy: "automation",
      });
      await notifyAutoSent({ artistUserId, contactName, contactId });
      console.log(`✅ [Consent Automation] Auto-sent consent form to ${contactName}`);
    } else {
      stats.errors++;
    }
    return;
  }

  // ── Fields missing → one task, ever ──
  if (row?.cc_task_id || row?.state === "task_created") {
    // Task already open; the next tick re-checks the fields.
    stats.skipped++;
    return;
  }

  await upsertAutomationRow({ ...baseRow, state: "task_created" });

  const taskId = await createFieldsNeededTask({
    contactId,
    contactName,
    artistUserId,
    appointmentId,
    appointmentStart,
    missing,
  });

  if (taskId) {
    await patchAutomationRow(appointmentId, {
      cc_task_id: taskId,
      task_created_at: new Date().toISOString(),
    });
    stats.tasksCreated++;
    console.log(
      `📋 [Consent Automation] Task created for ${contactName} — missing ${missingFieldLabels(missing).join(", ")}`
    );
  } else if (!TASKS_ENABLED) {
    // Roll back to pending so the task gets created once the flag is flipped on.
    await patchAutomationRow(appointmentId, { state: "pending" });
    stats.skipped++;
  } else {
    stats.errors++;
  }
}

async function notifyAutoSent({ artistUserId, contactName, contactId }) {
  if (!artistUserId || DRY_RUN) return;
  await sendPushToGhlUser(artistUserId, (language) => {
    const isSpanish = language === "es";
    return {
      type: "task_completed",
      title: isSpanish ? "Consentimiento enviado" : "Consent form sent",
      body: isSpanish
        ? `Se envió automáticamente el formulario a ${contactName}.`
        : `Automatically sent the consent form to ${contactName}.`,
      contactId,
      taskId: null,
    };
  });
}

/**
 * Appointments that were cancelled after we opened a task: close the task so it
 * stops nagging the artist about a session that isn't happening.
 */
async function closeCancelledAppointments(events, stats) {
  const cancelled = events.filter(
    (e) => TATTOO_CALENDAR_IDS.has(e.calendarId) && DEAD_STATUSES.has(normalizeStatus(e))
  );
  if (cancelled.length === 0) return;

  for (const event of cancelled) {
    try {
      const row = await getAutomationRow(event.id);
      if (!row || row.state !== "task_created") continue;

      if (row.cc_task_id) {
        await completeOpenTasks({
          contactId: row.contact_id,
          types: [CC_TASK_TYPE],
          completedBy: "automation",
          taskId: row.cc_task_id,
        });
      }
      await patchAutomationRow(event.id, { state: "closed_cancelled" });
      console.log(`🚫 [Consent Automation] Closed task for cancelled appointment ${event.id}`);
    } catch (err) {
      stats.errors++;
      console.error(`❌ [Consent Automation] Cancel cleanup failed for ${event.id}:`, err.message);
    }
  }
}

// ─── fill & send (the task's one button) ──────────────────────────────

/**
 * Write the artist-confirmed fields to GHL, send the consent form, and complete
 * the Command Center task — one atomic-feeling call so "task done" and "form
 * sent" can never diverge.
 *
 * @param {object} params
 * @param {string} params.appointmentId
 * @param {number} params.quotedPrice
 * @param {string} params.tattooPlacement
 * @param {number} [params.numberOfSessions]
 * @param {string} [params.completedByGhlUserId]
 * @returns {{ success, alreadySent?, formUrl?, error? }}
 */
async function fillAndSend({
  appointmentId,
  quotedPrice,
  tattooPlacement,
  numberOfSessions = 1,
  completedByGhlUserId = null,
}) {
  if (!appointmentId) {
    return { success: false, error: "appointmentId is required" };
  }

  const row = await getAutomationRow(appointmentId);
  if (!row) {
    return { success: false, error: "No consent automation record for this appointment" };
  }

  // Idempotency: a double-tap or a retry after a timeout must not send twice.
  if (["sent", "sending"].includes(row.state)) {
    if (row.cc_task_id) {
      await completeOpenTasks({
        contactId: row.contact_id,
        types: [CC_TASK_TYPE],
        completedBy: completedByGhlUserId || "automation",
        taskId: row.cc_task_id,
      });
    }
    return { success: true, alreadySent: true };
  }

  const price = parseQuote(quotedPrice);
  const placement = cleanText(tattooPlacement);

  if (!price) return { success: false, error: "A quoted price greater than 0 is required" };
  if (!placement) return { success: false, error: "Tattoo placement is required" };

  const contactId = row.contact_id;

  // 1. Write the artist's confirmed values to GHL so the CRM matches the form.
  try {
    await updateContact(contactId, {
      customFields: [
        { id: FIELD_IDS.finalPrice, field_value: String(price) },
        { id: FIELD_IDS.tattooPlacement, field_value: placement },
        { id: GHL_FIELD_IDS.locationOfTattoo, field_value: placement },
      ],
    });
  } catch (err) {
    console.error("❌ [Consent Automation] GHL field write failed:", err.message);
    return { success: false, error: `Could not save the details to the client's profile: ${err.message}` };
  }

  // 2. Claim + send.
  const procedureDate = row.appointment_start
    ? centralDateString(new Date(row.appointment_start))
    : null;

  const result = await claimAndSend({
    row,
    contactId,
    appointmentId,
    quotedPrice: price,
    tattooPlacement: placement,
    numberOfSessions,
    artistName: row.artist_name,
    procedureDate,
    via: "task",
  });

  if (!result.sent) {
    // Task stays open so the artist can retry.
    return { success: false, error: result.error || "Could not send the consent form" };
  }

  // 3. Close the task (and any generic consent task riding alongside it).
  if (row.cc_task_id) {
    await completeOpenTasks({
      contactId,
      types: [CC_TASK_TYPE],
      completedBy: completedByGhlUserId || "automation",
      taskId: row.cc_task_id,
    });
  }
  await completeOpenTasks({
    contactId,
    types: SUPERSEDED_TASK_TYPES,
    completedBy: completedByGhlUserId || "automation",
  });

  console.log(`✅ [Consent Automation] Fill-and-send complete for contact ${contactId}`);
  return { success: true, formUrl: result.formUrl };
}

/**
 * Context for the task sheet: current field values + appointment details so the
 * sheet can pre-fill whatever is already known.
 */
async function getTaskContext(appointmentId) {
  const row = await getAutomationRow(appointmentId);
  if (!row) return { success: false, error: "No consent automation record for this appointment" };

  const contact = await getContact(row.contact_id);

  return {
    success: true,
    data: {
      contactId: row.contact_id,
      contactName:
        [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim() || "Client",
      artistName: row.artist_name,
      appointmentStart: row.appointment_start,
      appointmentDisplay: row.appointment_start
        ? centralDisplay(new Date(row.appointment_start))
        : null,
      quotedPrice: parseQuote(readCustomField(contact, "finalPrice")),
      tattooPlacement: cleanText(readCustomField(contact, "tattooPlacement")),
      missingFields: row.missing_fields || [],
      state: row.state,
      alreadySent: ["sent", "sending"].includes(row.state),
    },
  };
}

module.exports = {
  runConsentAutomationSweep,
  fillAndSend,
  getTaskContext,
  // exported for tests / manual verification
  centralDateString,
  parseQuote,
  readCustomField,
};
