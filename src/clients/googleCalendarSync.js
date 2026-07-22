// googleCalendarSync.js
// Phase 2 (inbound) of the Google Calendar two-way sync: mirror each connected
// staff member's busy personal-calendar events into GHL as BLOCK SLOTS on
// their service calendar ("shadow block" model). getSlots already excludes
// block slots, so a personal event automatically blocks the websites, kiosk,
// AI setter, and in-app booking — and iOS already renders block slots.
//
// Privacy: the GHL block title is always "Busy". The real title/description
// live only in Supabase google_calendar_events (service-role only) and are
// role-gated by the API in Phase 3.
//
// Design: windowed reconcile (idempotent, re-runnable). syncStaffCalendar()
// lists Google events in [now-1d, now+RANGE] and diffs against our mapping
// rows: create/update/delete GHL blocks to match. The Phase-2b watch-channel
// webhook simply calls this again on each nudge — correctness never depends
// on Google syncToken semantics (we still store nextSyncToken when Google
// returns one, for a future incremental fast-path).
//
// Plan: GOOGLE_CALENDAR_SYNC_PLAN.md (iOS repo root).

require("dotenv").config({ quiet: true });
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const googleCalOAuth = require("./googleCalendarOAuth");
const { ghl } = require("./ghlSdk");
const { ghlBarber } = require("./ghlMultiLocationSdk");
const {
  BARBER_DATA,
  BARBER_LOCATION_ID,
  TATTOO_ARTIST_DATA,
  TATTOO_LOCATION_ID,
} = require("../config/kioskConfig");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const DEFAULT_RANGE_DAYS = 60; // matches the booking widget's 60-day window
const PAST_GRACE_DAYS = 1;

// Outbound (Phase 4) tags its Google events with this so inbound never
// re-imports a shop appointment as a "personal" block (loop guard).
const ORIGIN_KEY = "studioaz_origin";
const ORIGIN_VALUE = "ghl";

/** staff ghlUserId -> { locationId, sdk } from the kiosk roster.
 *  Block slots are PER-USER in GHL: the API takes assignedUserId + locationId
 *  and blocks the user across all their calendars. Do NOT pass calendarId —
 *  the SDK's DTO marks it required (types incomplete, known gotcha) but a
 *  round_robin service calendar id gets rejected with "The calendar is not an
 *  event calendar". Mirrors iOS CalendarService.createBlockSlot. */
function resolveStaffCalendar(staffGhlId, locationIdHint = null) {
  const tattoo = TATTOO_ARTIST_DATA.find((a) => a.ghlUserId === staffGhlId);
  if (tattoo) return { locationId: TATTOO_LOCATION_ID, sdk: ghl };
  const barber = BARBER_DATA.find((b) => b.ghlUserId === staffGhlId);
  if (barber) return { locationId: BARBER_LOCATION_ID, sdk: ghlBarber };

  // Not a booking artist (admins, owner, brand-new hires not yet in
  // kioskConfig). Block slots are per-USER — assignedUserId + locationId is
  // all the API needs — so the roster is only a convenience. Fall back to the
  // location captured at connect time.
  if (locationIdHint === BARBER_LOCATION_ID) {
    return { locationId: BARBER_LOCATION_ID, sdk: ghlBarber };
  }
  if (locationIdHint === TATTOO_LOCATION_ID) {
    return { locationId: TATTOO_LOCATION_ID, sdk: ghl };
  }
  return null;
}

/** List every event in the window (paginated). Returns { events, nextSyncToken }. */
async function listWindowEvents(accessToken, googleCalendarId, rangeDays) {
  const timeMin = new Date(Date.now() - PAST_GRACE_DAYS * 86400_000).toISOString();
  const timeMax = new Date(Date.now() + rangeDays * 86400_000).toISOString();
  const events = [];
  let pageToken;
  let nextSyncToken = null;

  do {
    const resp = await axios.get(
      `${CALENDAR_API}/calendars/${encodeURIComponent(googleCalendarId)}/events`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          timeMin,
          timeMax,
          singleEvents: true, // expand recurring events into instances
          maxResults: 250,
          pageToken,
        },
      }
    );
    events.push(...(resp.data.items || []));
    pageToken = resp.data.nextPageToken;
    if (resp.data.nextSyncToken) nextSyncToken = resp.data.nextSyncToken;
  } while (pageToken);

  return { events, nextSyncToken };
}

/** Should this Google event block the staff member's availability? */
function isBlockingEvent(ev) {
  if (!ev || ev.status === "cancelled") return false;
  // Free/transparent events (e.g. "Out of office" marked free) don't block.
  if (ev.transparency === "transparent") return false;
  // All-day events are date-only; skipped for now (plan: revisit in Phase 2b —
  // options are block working hours or a per-staff toggle).
  if (!ev.start?.dateTime || !ev.end?.dateTime) return false;
  // Loop guard: never re-import an event WE created from a shop appointment.
  if (ev.extendedProperties?.private?.[ORIGIN_KEY] === ORIGIN_VALUE) return false;
  // Events the user declined don't block.
  const self = (ev.attendees || []).find((a) => a.self);
  if (self && self.responseStatus === "declined") return false;
  return true;
}

/**
 * Refresh the staff member's calendar list from Google (calendarList API).
 * Syncs every calendar the user has SELECTED in the Google Calendar UI —
 * their own calendars plus subscriptions (e.g. a team schedule feed). This
 * matches the user's mental model: "what my Google Calendar shows, blocks."
 */
async function refreshCalendarList(staffGhlId) {
  const accessToken = await googleCalOAuth.getValidAccessToken(staffGhlId);
  const resp = await axios.get(`${CALENDAR_API}/users/me/calendarList`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { maxResults: 250, showHidden: false },
  });
  const items = resp.data.items || [];
  const selected = items.filter((c) => c.selected);

  for (const cal of selected) {
    await supabase.from("staff_google_calendars").upsert(
      {
        staff_ghl_user_id: staffGhlId,
        google_calendar_id: cal.id,
        summary: cal.summaryOverride || cal.summary || null,
        access_role: cal.accessRole || null,
        is_primary: !!cal.primary,
        selected: true,
      },
      { onConflict: "staff_ghl_user_id,google_calendar_id" }
    );
  }

  // Calendars unchecked in Google since last refresh: mark deselected so the
  // sync prunes their blocks.
  const activeIds = selected.map((c) => c.id);
  const { data: known } = await supabase
    .from("staff_google_calendars")
    .select("google_calendar_id")
    .eq("staff_ghl_user_id", staffGhlId);
  for (const row of known || []) {
    if (!activeIds.includes(row.google_calendar_id)) {
      await supabase
        .from("staff_google_calendars")
        .update({ selected: false })
        .eq("staff_ghl_user_id", staffGhlId)
        .eq("google_calendar_id", row.google_calendar_id);
    }
  }
  return activeIds;
}

/**
 * Reconcile ALL of a staff member's selected Google calendars into GHL block
 * slots. Idempotent: safe to call from connect, from the watch webhook, from
 * a cron, or manually via /google/sync-now.
 */
async function syncStaffCalendar(staffGhlId, { rangeDays = DEFAULT_RANGE_DAYS } = {}) {
  const tokenRow = await googleCalOAuth.getStaffToken(staffGhlId);
  if (!tokenRow) throw new Error(`No Google Calendar connected for staff ${staffGhlId}`);

  const staffCal = resolveStaffCalendar(staffGhlId, tokenRow.location_id);
  if (!staffCal) {
    throw new Error(
      `Cannot resolve a GHL location for staff ${staffGhlId} (token location_id: ${tokenRow.location_id || "none"}) — cannot anchor block slots`
    );
  }

  await refreshCalendarList(staffGhlId);
  const { data: calendars, error: calErr } = await supabase
    .from("staff_google_calendars")
    .select("*")
    .eq("staff_ghl_user_id", staffGhlId);
  if (calErr) throw new Error(calErr.message);

  const totals = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0, calendars: 0 };
  for (const cal of calendars || []) {
    const s = await syncOneCalendar(staffGhlId, staffCal, cal, rangeDays);
    totals.created += s.created;
    totals.updated += s.updated;
    totals.deleted += s.deleted;
    totals.unchanged += s.unchanged;
    totals.skipped += s.skipped;
    if (cal.selected) totals.calendars++;
  }

  await supabase
    .from("staff_google_tokens")
    .update({ last_synced_at: new Date().toISOString(), sync_status: "connected", last_error: null })
    .eq("staff_ghl_user_id", staffGhlId);

  console.log(
    `[GCalSync] ${staffGhlId}: ${totals.calendars} calendars — ${totals.created} created, ` +
      `${totals.updated} updated, ${totals.deleted} deleted, ${totals.unchanged} unchanged, ${totals.skipped} skipped`
  );
  return totals;
}

/** Reconcile ONE calendar. Deselected calendars just get their blocks pruned. */
async function syncOneCalendar(staffGhlId, staffCal, cal, rangeDays) {
  const googleCalendarId = cal.google_calendar_id;
  const accessToken = await googleCalOAuth.getValidAccessToken(staffGhlId);

  let events = [];
  let nextSyncToken = null;
  if (cal.selected) {
    const listed = await listWindowEvents(accessToken, googleCalendarId, rangeDays);
    events = listed.events;
    nextSyncToken = listed.nextSyncToken;
  }
  const blocking = events.filter(isBlockingEvent);
  const blockingById = new Map(blocking.map((ev) => [ev.id, ev]));

  // Existing inbound mapping rows for this staff member + THIS calendar.
  const { data: rows, error: rowsErr } = await supabase
    .from("google_calendar_events")
    .select("*")
    .eq("staff_ghl_user_id", staffGhlId)
    .eq("google_calendar_id", googleCalendarId)
    .eq("direction", "inbound");
  if (rowsErr) throw new Error(`Failed to load mapping rows: ${rowsErr.message}`);
  const rowByEventId = new Map((rows || []).map((r) => [r.google_event_id, r]));

  const summary = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: events.length - blocking.length };

  // 1) Create/update blocks for every blocking Google event.
  for (const ev of blocking) {
    const row = rowByEventId.get(ev.id);
    const startISO = new Date(ev.start.dateTime).toISOString();
    const endISO = new Date(ev.end.dateTime).toISOString();
    const title = ev.summary || "(no title)";

    if (!row) {
      const blockResp = await staffCal.sdk.calendars.createBlockSlot({
        title: "Busy",
        assignedUserId: staffGhlId,
        locationId: staffCal.locationId,
        startTime: startISO,
        endTime: endISO,
      });
      const blockId = blockResp?.id || blockResp?.data?.id;
      if (!blockId) throw new Error(`GHL createBlockSlot returned no id for event ${ev.id}`);

      const { error: insErr } = await supabase.from("google_calendar_events").insert({
        staff_ghl_user_id: staffGhlId,
        google_event_id: ev.id,
        google_calendar_id: googleCalendarId,
        ical_uid: ev.iCalUID || null,
        etag: ev.etag || null,
        direction: "inbound",
        ghl_block_slot_id: blockId,
        real_title: title,
        real_description: null, // PII minimization: title only
        start_time: startISO,
        end_time: endISO,
        is_all_day: false,
        transparency: ev.transparency || "opaque",
        status: ev.status || "confirmed",
        location_id: staffCal.locationId,
      });
      if (insErr) {
        // Roll back the orphan block so a retry doesn't double-block the slot.
        await staffCal.sdk.calendars
          .deleteEvent({ eventId: blockId })
          .catch((e) => console.error(`[GCalSync] Orphan block ${blockId} cleanup failed:`, e.message));
        throw new Error(`Mapping insert failed for event ${ev.id}: ${insErr.message}`);
      }
      summary.created++;
    } else {
      const changed =
        new Date(row.start_time).getTime() !== new Date(startISO).getTime() ||
        new Date(row.end_time).getTime() !== new Date(endISO).getTime() ||
        row.real_title !== title;
      if (!changed) {
        summary.unchanged++;
        continue;
      }
      try {
        await staffCal.sdk.calendars.editBlockSlot(
          { eventId: row.ghl_block_slot_id },
          {
            title: "Busy",
            assignedUserId: staffGhlId,
            startTime: startISO,
            endTime: endISO,
          }
        );
      } catch (e) {
        // Block hand-deleted in GHL — self-heal by recreating instead of
        // failing the whole sweep (Phase 6 hardening).
        console.warn(`[GCalSync] editBlockSlot ${row.ghl_block_slot_id} failed (${e.message}) — recreating`);
        const blockResp = await staffCal.sdk.calendars.createBlockSlot({
          title: "Busy",
          assignedUserId: staffGhlId,
          locationId: staffCal.locationId,
          startTime: startISO,
          endTime: endISO,
        });
        const newId = blockResp?.id || blockResp?.data?.id;
        if (!newId) throw new Error(`Recreate returned no id for event ${ev.id}`);
        await supabase
          .from("google_calendar_events")
          .update({ ghl_block_slot_id: newId })
          .eq("id", row.id);
        row.ghl_block_slot_id = newId;
      }
      await supabase
        .from("google_calendar_events")
        .update({ start_time: startISO, end_time: endISO, real_title: title, etag: ev.etag || null, status: ev.status || "confirmed" })
        .eq("id", row.id);
      summary.updated++;
    }
  }

  // 2) Delete blocks whose Google event is gone (deleted/cancelled/declined/
  //    turned transparent) or has left the sync window.
  const windowEnd = Date.now() + rangeDays * 86400_000;
  for (const row of rows || []) {
    if (blockingById.has(row.google_event_id)) continue;
    // Rows already beyond the window that we never blocked wouldn't exist;
    // rows starting past the window edge were synced under a wider range —
    // still remove them so state matches the current window.
    void windowEnd;
    await staffCal.sdk.calendars
      .deleteEvent({ eventId: row.ghl_block_slot_id })
      .catch((e) => {
        // Block already gone in GHL (deleted by hand) — fine, still drop the row.
        console.warn(`[GCalSync] deleteEvent ${row.ghl_block_slot_id}: ${e.message}`);
      });
    await supabase.from("google_calendar_events").delete().eq("id", row.id);
    summary.deleted++;
  }

  // 3) Record per-calendar sync health (+ syncToken for a future fast-path).
  await supabase
    .from("staff_google_calendars")
    .update({
      last_synced_at: new Date().toISOString(),
      ...(nextSyncToken ? { sync_token: nextSyncToken } : {}),
    })
    .eq("staff_ghl_user_id", staffGhlId)
    .eq("google_calendar_id", googleCalendarId);

  return summary;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2b — near-real-time via events.watch push channels
// Google POSTs a nudge (no payload) to our webhook on any calendar change;
// we respond by re-running the windowed reconcile above. Channels expire
// (~7 days), so a renewal loop re-registers anything expiring within 24h.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require("crypto");

const WEBHOOK_ADDRESS =
  process.env.GOOGLE_CALENDAR_WEBHOOK_URL ||
  "https://studio-az-setter-backend.onrender.com/webhooks/google/calendar";
const WATCH_TTL_SECONDS = 7 * 24 * 3600; // request the max default (7 days)

// Coalesce bursts: one reconcile in flight per staff member, at most one queued.
const inFlight = new Map(); // staffGhlId -> { running: Promise, pending: bool }

async function runCoalescedSync(staffGhlId) {
  const entry = inFlight.get(staffGhlId);
  if (entry) {
    entry.pending = true; // a run is active — remember to go once more
    return entry.running;
  }
  const state = { pending: false, running: null };
  state.running = (async () => {
    try {
      do {
        state.pending = false;
        await syncStaffCalendar(staffGhlId);
      } while (state.pending);
    } finally {
      inFlight.delete(staffGhlId);
    }
  })();
  inFlight.set(staffGhlId, state);
  return state.running;
}

/** Best-effort stop of ONE calendar row's push channel. */
async function stopCalendarWatch(staffGhlId, calRow) {
  if (!calRow?.watch_channel_id || !calRow?.watch_resource_id) return;
  try {
    const accessToken = await googleCalOAuth.getValidAccessToken(staffGhlId);
    await axios.post(
      `${CALENDAR_API}/channels/stop`,
      { id: calRow.watch_channel_id, resourceId: calRow.watch_resource_id },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (e) {
    // Channel already expired/stopped — nothing to do.
    console.warn(`[GCalSync] channels.stop ${calRow.google_calendar_id}: ${e.response?.data?.error?.message || e.message}`);
  }
  await supabase
    .from("staff_google_calendars")
    .update({ watch_channel_id: null, watch_resource_id: null, watch_expiration: null, watch_channel_token: null })
    .eq("id", calRow.id);
}

/** Stop every push channel a staff member has (used on disconnect). */
async function stopWatchChannel(staffGhlId) {
  const { data: cals } = await supabase
    .from("staff_google_calendars")
    .select("*")
    .eq("staff_ghl_user_id", staffGhlId)
    .not("watch_channel_id", "is", null);
  for (const cal of cals || []) {
    await stopCalendarWatch(staffGhlId, cal);
  }
  return true;
}

/** Register the events.watch push channel for ONE calendar row. */
async function registerCalendarWatch(staffGhlId, calRow) {
  if (calRow.watch_channel_id) await stopCalendarWatch(staffGhlId, calRow);

  const accessToken = await googleCalOAuth.getValidAccessToken(staffGhlId);
  const channelId = crypto.randomUUID();
  const channelToken = crypto.randomBytes(24).toString("hex");

  const resp = await axios.post(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calRow.google_calendar_id)}/events/watch`,
    {
      id: channelId,
      type: "web_hook",
      address: WEBHOOK_ADDRESS,
      token: channelToken,
      params: { ttl: String(WATCH_TTL_SECONDS) },
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const expiration = resp.data.expiration
    ? new Date(Number(resp.data.expiration)).toISOString()
    : new Date(Date.now() + WATCH_TTL_SECONDS * 1000).toISOString();

  await supabase
    .from("staff_google_calendars")
    .update({
      watch_channel_id: channelId,
      watch_resource_id: resp.data.resourceId,
      watch_expiration: expiration,
      watch_channel_token: channelToken,
    })
    .eq("id", calRow.id);

  console.log(`[GCalSync] watch registered: ${staffGhlId} / ${calRow.google_calendar_id}, expires ${expiration}`);
  return { channelId, expiration };
}

/**
 * Ensure every SELECTED calendar has a live push channel (register missing
 * or expiring-within-24h ones). Returns how many were (re)registered.
 */
async function registerWatchChannel(staffGhlId) {
  const { data: cals, error } = await supabase
    .from("staff_google_calendars")
    .select("*")
    .eq("staff_ghl_user_id", staffGhlId)
    .eq("selected", true);
  if (error) throw new Error(error.message);
  if (!cals?.length) throw new Error(`No calendars on file for staff ${staffGhlId} — sync first`);

  const cutoff = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  let registered = 0;
  const results = [];
  for (const cal of cals) {
    const needs = !cal.watch_channel_id || (cal.watch_expiration && cal.watch_expiration < cutoff);
    if (!needs) continue;
    try {
      results.push(await registerCalendarWatch(staffGhlId, cal));
      registered++;
    } catch (e) {
      // Some subscribed calendars refuse watch (rare) — sync still covers
      // them via the 6h safety net.
      console.warn(`[GCalSync] watch failed for ${cal.google_calendar_id}: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  return { registered, total: cals.length, channels: results };
}

/**
 * Handle a webhook nudge. Returns 200-worthy truthiness fast; the reconcile
 * runs after we've already ACKed (caller responds immediately).
 * Validates the per-channel secret so random POSTs can't trigger syncs.
 */
async function handleWatchNudge({ channelId, channelToken, resourceState }) {
  if (!channelId) return { ok: false, reason: "missing channel id" };

  const { data: row, error } = await supabase
    .from("staff_google_calendars")
    .select("staff_ghl_user_id, watch_channel_token")
    .eq("watch_channel_id", channelId)
    .single();
  if (error || !row) return { ok: false, reason: "unknown channel" };
  if (row.watch_channel_token && row.watch_channel_token !== channelToken) {
    return { ok: false, reason: "bad channel token" };
  }

  // "sync" = registration handshake ping; nothing changed yet.
  if (resourceState === "sync") return { ok: true, action: "handshake" };

  // Fire the reconcile without blocking the ACK.
  runCoalescedSync(row.staff_ghl_user_id).catch((e) =>
    console.error(`[GCalSync] nudge sync failed for ${row.staff_ghl_user_id}:`, e.message)
  );
  return { ok: true, action: "sync_started", staffGhlId: row.staff_ghl_user_id };
}

/**
 * In-process renewal loop (same pattern as cacheReconcileLoop): every 6h,
 * re-register channels expiring within 24h and self-heal connected rows that
 * lost their channel. Also reconciles those calendars as a safety net.
 */
function startGoogleWatchRenewalLoop() {
  const SIX_HOURS = 6 * 3600 * 1000;
  const tick = async () => {
    try {
      const { data: rows, error } = await supabase
        .from("staff_google_tokens")
        .select("staff_ghl_user_id")
        .neq("sync_status", "disconnected");
      if (error) throw new Error(error.message);
      for (const row of rows || []) {
        try {
          // Safety-net reconcile for EVERY connected staff member each tick
          // (also refreshes their calendar list), then top up any missing or
          // expiring-within-24h per-calendar watch channels.
          await runCoalescedSync(row.staff_ghl_user_id);
          await registerWatchChannel(row.staff_ghl_user_id);
        } catch (e) {
          console.error(`[GCalSync] renewal/reconcile failed for ${row.staff_ghl_user_id}:`, e.message);
        }
      }
    } catch (e) {
      console.error("[GCalSync] renewal loop tick failed:", e.message);
    }
  };
  setTimeout(tick, 90_000); // startup grace, then every 6h
  setInterval(tick, SIX_HOURS);
  console.log("[GCalSync] watch renewal loop started (6h interval)");
}

/** Post-connect bootstrap: initial sync + watch registration, fire-and-forget. */
async function bootstrapAfterConnect(staffGhlId) {
  await runCoalescedSync(staffGhlId);
  await registerWatchChannel(staffGhlId);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4 — outbound: shop appointments -> the artist's personal Google
// Calendar. Events are tagged studioaz_origin=ghl so the inbound reconcile
// never re-imports them (loop guard). Called from appointmentWebhooks.js;
// every function is a no-op for staff without a Google connection.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create or update the Google mirror event for a GHL appointment.
 * appt: raw GHL webhook shape ({ id, assignedUserId, startTime, endTime,
 * title, appointmentStatus|status, calendarId }).
 */
async function mirrorAppointmentToGoogle(appt) {
  const staffGhlId = appt.assignedUserId;
  const apptId = appt.id || appt.appointmentId;
  if (!staffGhlId || !apptId || !appt.startTime || !appt.endTime) return null;

  const tokenRow = await googleCalOAuth.getStaffToken(staffGhlId);
  if (!tokenRow || tokenRow.sync_status === "disconnected") return null; // not connected — nothing to mirror

  const status = appt.appointmentStatus || appt.status;
  if (status === "cancelled" || status === "Cancelled") {
    return removeAppointmentFromGoogle(apptId);
  }

  const staffCal = resolveStaffCalendar(staffGhlId, tokenRow.location_id);
  const googleCalendarId = tokenRow.calendar_id || "primary";
  const accessToken = await googleCalOAuth.getValidAccessToken(staffGhlId);

  const body = {
    summary: appt.title || "Studio AZ appointment",
    description: "Booked via Studio AZ. Managed automatically — edits made here are not synced back to the shop.",
    start: { dateTime: new Date(appt.startTime).toISOString() },
    end: { dateTime: new Date(appt.endTime).toISOString() },
    extendedProperties: {
      private: { [ORIGIN_KEY]: ORIGIN_VALUE, ghl_appointment_id: apptId },
    },
  };

  const { data: existing } = await supabase
    .from("google_calendar_events")
    .select("*")
    .eq("ghl_appointment_id", apptId)
    .eq("direction", "outbound")
    .maybeSingle();

  if (existing) {
    try {
      const resp = await axios.patch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(googleCalendarId)}/events/${existing.google_event_id}`,
        body,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      await supabase
        .from("google_calendar_events")
        .update({
          start_time: body.start.dateTime,
          end_time: body.end.dateTime,
          real_title: body.summary,
          etag: resp.data.etag || null,
          status: "confirmed",
        })
        .eq("id", existing.id);
      console.log(`[GCalSync] outbound updated: appt ${apptId} -> google ${existing.google_event_id}`);
      return { action: "updated", googleEventId: existing.google_event_id };
    } catch (e) {
      if (e.response?.status !== 404 && e.response?.status !== 410) throw e;
      // Mirror event was deleted in Google by hand — fall through and recreate.
      await supabase.from("google_calendar_events").delete().eq("id", existing.id);
    }
  }

  const resp = await axios.post(
    `${CALENDAR_API}/calendars/${encodeURIComponent(googleCalendarId)}/events`,
    body,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  await supabase.from("google_calendar_events").insert({
    staff_ghl_user_id: staffGhlId,
    google_event_id: resp.data.id,
    google_calendar_id: googleCalendarId,
    ical_uid: resp.data.iCalUID || null,
    etag: resp.data.etag || null,
    direction: "outbound",
    ghl_appointment_id: apptId,
    real_title: body.summary,
    start_time: body.start.dateTime,
    end_time: body.end.dateTime,
    is_all_day: false,
    transparency: "opaque",
    status: "confirmed",
    location_id: staffCal?.locationId || tokenRow.location_id,
  });
  console.log(`[GCalSync] outbound created: appt ${apptId} -> google ${resp.data.id}`);
  return { action: "created", googleEventId: resp.data.id };
}

/** Delete the Google mirror event for a cancelled/deleted GHL appointment. */
async function removeAppointmentFromGoogle(apptId) {
  if (!apptId) return null;
  const { data: row } = await supabase
    .from("google_calendar_events")
    .select("*")
    .eq("ghl_appointment_id", apptId)
    .eq("direction", "outbound")
    .maybeSingle();
  if (!row) return null;

  try {
    const accessToken = await googleCalOAuth.getValidAccessToken(row.staff_ghl_user_id);
    await axios.delete(
      `${CALENDAR_API}/calendars/${encodeURIComponent(row.google_calendar_id)}/events/${row.google_event_id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (e) {
    const code = e.response?.status;
    if (code !== 404 && code !== 410) {
      console.error(`[GCalSync] outbound delete failed for appt ${apptId}: ${e.message}`);
      // Keep the row so a later retry can clean up.
      throw e;
    }
  }
  await supabase.from("google_calendar_events").delete().eq("id", row.id);
  console.log(`[GCalSync] outbound removed: appt ${apptId} (google ${row.google_event_id})`);
  return { action: "deleted", googleEventId: row.google_event_id };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — edit-back: change a Google-origin event from inside the iOS app.
// PATCHes Google (with If-Match optimistic concurrency), then keeps the GHL
// block + mapping row consistent. Phase 6 — disconnect cleanup + audit trail.
// ═══════════════════════════════════════════════════════════════════════════

/** Append-only audit record (best-effort — never fails the caller). */
async function logGoogleAudit({ actorGhlId, actorName, actorRole, action, targetId, summary, details, locationId }) {
  try {
    await supabase.from("audit_events").insert({
      actor_ghl_id: actorGhlId || null,
      actor_name: actorName || actorGhlId || "unknown",
      actor_role: actorRole || null,
      action,
      target_type: "google_calendar",
      target_id: targetId || null,
      summary,
      details: details || null,
      location_id: locationId || null,
      source: "backend",
    });
  } catch (e) {
    console.warn(`[GCalSync] audit insert failed (${action}): ${e.message}`);
  }
}

/**
 * Edit a Google-origin (inbound) event from the app.
 * Returns { conflict: true } when the event changed in Google since we last
 * synced (etag mismatch) — the caller should refresh rather than clobber.
 */
async function editGoogleOriginEvent({ staffGhlId, googleEventId, startTime, endTime, title }) {
  // limit(1): with multi-calendar sync the same event id can appear on two
  // calendars (e.g. an invite mirrored onto a shared calendar) — editing any
  // one instance edits the underlying Google event.
  const { data: rowList, error } = await supabase
    .from("google_calendar_events")
    .select("*")
    .eq("staff_ghl_user_id", staffGhlId)
    .eq("google_event_id", googleEventId)
    .eq("direction", "inbound")
    .limit(1);
  if (error) throw new Error(error.message);
  const row = rowList?.[0];
  if (!row) throw new Error(`No inbound mapping for event ${googleEventId} (staff ${staffGhlId})`);

  const accessToken = await googleCalOAuth.getValidAccessToken(staffGhlId);
  const patch = {};
  if (startTime) patch.start = { dateTime: new Date(startTime).toISOString() };
  if (endTime) patch.end = { dateTime: new Date(endTime).toISOString() };
  if (title !== undefined && title !== null && title !== "") patch.summary = title;

  let resp;
  try {
    resp = await axios.patch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(row.google_calendar_id || "primary")}/events/${googleEventId}`,
      patch,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(row.etag ? { "If-Match": row.etag } : {}),
        },
      }
    );
  } catch (e) {
    if (e.response?.status === 412) {
      // Event moved underneath us — re-sync so the app shows current truth.
      runCoalescedSync(staffGhlId).catch(() => {});
      return { conflict: true };
    }
    throw e;
  }

  const newStart = resp.data.start?.dateTime
    ? new Date(resp.data.start.dateTime).toISOString()
    : row.start_time;
  const newEnd = resp.data.end?.dateTime
    ? new Date(resp.data.end.dateTime).toISOString()
    : row.end_time;
  const newTitle = resp.data.summary || row.real_title;

  const staffCal = resolveStaffCalendar(staffGhlId, row.location_id);
  try {
    await staffCal.sdk.calendars.editBlockSlot(
      { eventId: row.ghl_block_slot_id },
      { title: "Busy", assignedUserId: staffGhlId, startTime: newStart, endTime: newEnd }
    );
  } catch (e) {
    // Block missing — the next reconcile self-heals; don't fail the edit.
    console.warn(`[GCalSync] edit-back block update failed: ${e.message}`);
    runCoalescedSync(staffGhlId).catch(() => {});
  }

  await supabase
    .from("google_calendar_events")
    .update({
      start_time: newStart,
      end_time: newEnd,
      real_title: newTitle,
      etag: resp.data.etag || null,
    })
    .eq("id", row.id);

  return {
    conflict: false,
    googleEventId,
    startTime: newStart,
    endTime: newEnd,
    title: newTitle,
  };
}

/**
 * Disconnect cleanup (Phase 6): remove every inbound GHL block, delete
 * FUTURE outbound mirror events from the artist's Google calendar (past ones
 * stay — they're history), then drop mapping rows. Runs BEFORE token revoke.
 */
async function cleanupOnDisconnect(staffGhlId) {
  const tokenRow = await googleCalOAuth.getStaffToken(staffGhlId);
  const staffCal = resolveStaffCalendar(staffGhlId, tokenRow?.location_id);
  const { data: rows } = await supabase
    .from("google_calendar_events")
    .select("*")
    .eq("staff_ghl_user_id", staffGhlId);
  if (!rows?.length) return { blocksRemoved: 0, mirrorsRemoved: 0 };

  let blocksRemoved = 0;
  let mirrorsRemoved = 0;
  let accessToken = null;
  try {
    accessToken = await googleCalOAuth.getValidAccessToken(staffGhlId);
  } catch (_) {
    // Token already dead — GHL cleanup still proceeds; Google mirrors stay.
  }

  for (const row of rows) {
    if (row.direction === "inbound" && row.ghl_block_slot_id && staffCal) {
      await staffCal.sdk.calendars
        .deleteEvent({ eventId: row.ghl_block_slot_id })
        .then(() => blocksRemoved++)
        .catch((e) => console.warn(`[GCalSync] cleanup block ${row.ghl_block_slot_id}: ${e.message}`));
    }
    if (
      row.direction === "outbound" &&
      accessToken &&
      row.start_time &&
      new Date(row.start_time) > new Date()
    ) {
      await axios
        .delete(
          `${CALENDAR_API}/calendars/${encodeURIComponent(row.google_calendar_id || "primary")}/events/${row.google_event_id}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        )
        .then(() => mirrorsRemoved++)
        .catch(() => {});
    }
  }

  await supabase.from("google_calendar_events").delete().eq("staff_ghl_user_id", staffGhlId);
  await supabase.from("staff_google_calendars").delete().eq("staff_ghl_user_id", staffGhlId);
  console.log(`[GCalSync] disconnect cleanup for ${staffGhlId}: ${blocksRemoved} blocks, ${mirrorsRemoved} future mirrors removed`);
  return { blocksRemoved, mirrorsRemoved };
}

module.exports = {
  syncStaffCalendar,
  resolveStaffCalendar,
  runCoalescedSync,
  registerWatchChannel,
  stopWatchChannel,
  handleWatchNudge,
  startGoogleWatchRenewalLoop,
  bootstrapAfterConnect,
  mirrorAppointmentToGoogle,
  removeAppointmentFromGoogle,
  editGoogleOriginEvent,
  cleanupOnDisconnect,
  logGoogleAudit,
};
