/**
 * Appointment Reconciler
 *
 * Front Desk Dashboard — Phase 0.3b. ONE function, three callers
 * (FRONT_DESK_DASHBOARD_PLAN.md Sections 3.1 / 12):
 *   1. Launch backfill — once, both locations, today-1 → +60d.
 *   2. Dashboard "Refresh" button — scoped to one staffer / one day.
 *   3. Periodic safety sweep — full window every ~10–15 min, server-side.
 *
 * It fetches GHL truth for a scope and upserts any cache row that is
 * MISSING or DIFFERS. It is intentionally additive/corrective:
 *
 *   - It does NOT delete cache rows for GHL events it didn't see. A GHL
 *     paging gap or a userId-scoped fetch would otherwise wipe valid rows.
 *     Deletions are the webhook's job (handleAppointmentDeleted).
 *   - Row shape is produced the SAME way as the webhook path
 *     (mapGHLAppointmentToSupabase) so a reconcile never "differs" on a
 *     row the webhook just wrote (no thrashing).
 *
 * Safe to run repeatedly and concurrently with the live webhook.
 */

const { supabase } = require("./supabaseClient");
const { ghl } = require("./ghlSdk");
const { ghlBarber } = require("./ghlMultiLocationSdk");
const { fetchAppointmentsForDateRange } = require("./ghlCalendarClient");
const { mapGHLAppointmentToSupabase } = require("./appointmentWebhooks");
const {
  BARBER_DATA,
  BARBER_LOCATION_ID,
  TATTOO_ARTIST_DATA,
  TATTOO_LOCATION_ID,
} = require("../config/kioskConfig");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Resolve a location label/ID to { locationId, sdkInstance }. */
function resolveLocation(location) {
  // Accept "barbershop"/"tattoo" labels or a raw GHL locationId.
  const barberLoc = process.env.GHL_BARBER_LOCATION_ID || BARBER_LOCATION_ID;
  const tattooLoc = process.env.GHL_LOCATION_ID || TATTOO_LOCATION_ID;

  let locationId;
  if (location === "barbershop" || location === barberLoc) locationId = barberLoc;
  else if (location === "tattoo" || location === tattooLoc) locationId = tattooLoc;
  else throw new Error(`reconcileAppointments: unknown location "${location}"`);

  // Barbershop calls must use the barbershop SDK instance (separate token).
  // Tattoo uses the default SDK. Mirrors the established pattern in app.js.
  const isBarber = locationId === barberLoc;
  const sdkInstance = isBarber && ghlBarber ? ghlBarber : ghl;

  // GHL's /calendars/events REQUIRES userId|calendarId|groupId — there is
  // NO location-wide fetch. So a full-roster reconcile must iterate per
  // staff member. Roster comes from kioskConfig.js (now includes Anna).
  const roster = isBarber ? BARBER_DATA : TATTOO_ARTIST_DATA;

  return { locationId, sdkInstance, roster };
}

/**
 * Normalize a GHL calendar event into the canonical Supabase row.
 * GHL's /calendars/events shape matches the webhook payload's inner
 * appointment object closely, but: (a) status lives under any of
 * appointmentStatus | appoinmentStatus (GHL typo) | status, and
 * (b) the assignee can be assignedUserId OR userId. Patch those, then
 * defer to the shared mapper so the row shape is identical to the
 * webhook path.
 */
function eventToRow(event) {
  const patched = {
    ...event,
    appointmentStatus:
      event.appointmentStatus ||
      event.appoinmentStatus ||
      event.status ||
      "new",
    assignedUserId: event.assignedUserId || event.userId || null,
  };
  return mapGHLAppointmentToSupabase(patched);
}

/** Fields that actually matter for the dashboard — compare only these. */
const COMPARE_FIELDS = [
  "title",
  "calendar_id",
  "contact_id",
  "location_id",
  "start_time",
  "end_time",
  "status",
  "assigned_user_id",
];

function timesEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

/** True if the GHL-derived row differs from the cached row in a way we care about. */
function rowDiffers(incoming, existing) {
  for (const f of COMPARE_FIELDS) {
    if (f === "start_time" || f === "end_time") {
      if (!timesEqual(incoming[f], existing[f])) return true;
    } else if ((incoming[f] ?? null) !== (existing[f] ?? null)) {
      return true;
    }
  }
  return false;
}

/** GHL's composite id form for a recurring instance: `<baseId>_<epochMs>_<durationSec>`. */
const COMPOSITE_ID_RE = /^([A-Za-z0-9]{15,})_\d{10,}_\d+$/;

/** The dedicated GHL "break" calendar — these rows arrive on the EVENTS feed. */
const BREAK_CALENDAR_ID = "lijQ2ubF4UcrHxDwfzyK";

/**
 * Delete cache block rows that GHL no longer has (front-desk bug found
 * 2026-07-30).
 *
 * WHY THIS EXISTS. This module is deliberately additive — see the header:
 * deletions are the appointment webhook's job. That is correct for
 * bookings, but blocked slots are NOT appointments, so deleting a block
 * in GHL fires no appointment webhook at all. Block deletions therefore
 * had NO path into the cache and accumulated forever: Elle's recurring
 * 1:30pm "Break" was removed from GHL on 2026-06-29 (GHL records this as
 * an EXDATE on the parent RRULE, not a delete) and was still being drawn
 * on the desk a month later, on top of a real 1:30 booking.
 *
 * WHY DELETING HERE IS SAFE, where it isn't for appointments:
 *   - getBlockedSlots is fetched per-staff, per-window and returns the
 *     COMPLETE set for that scope, so the delete scope can be made to
 *     match the fetch scope exactly. There is no paging to gap.
 *   - We only ever consider rows this fetch owns (calendar_id ===
 *     "__block__", the sentinel the loop above writes). Break-calendar
 *     rows arrive on the events feed and are deliberately left alone.
 *   - Scoped by start_time INSIDE the window. GHL also returns blocks
 *     that merely OVERLAP the window, so our candidate set is a strict
 *     subset of what GHL answered for — never the other way round.
 *   - Fail-CLOSED: `blockFetchOk` is only true after a successful
 *     response. The fetch's catch is non-fatal, so without this guard a
 *     transient GHL error would read as "no blocks exist" and wipe every
 *     real block for that barber.
 *
 * Plus one narrow supersession case: GHL changed how it returns recurring
 * break instances (bare `<baseId>` → composite `<baseId>_<epoch>_<dur>`),
 * leaving orphaned bare-id twins in the cache that render as duplicate
 * cards. We remove a bare row only when GHL has POSITIVELY returned a
 * composite id derived from it — evidence of replacement, not an absence.
 *
 * @returns {Promise<number>} rows deleted
 */
async function reapDeletedBlocks({
  locationId,
  staffGhlUserId,
  startTime,
  endTime,
  liveBlockIds,
  liveEventIds,
  blockFetchOk,
  dryRun,
}) {
  // Fail-closed. Never infer "GHL has no blocks" from a failed fetch.
  if (!blockFetchOk) return 0;

  const winStart = new Date(startTime).toISOString();
  const winEnd = new Date(endTime).toISOString();

  const { data: cached, error } = await supabase
    .from("appointments")
    .select("id, title, start_time, calendar_id")
    .eq("location_id", locationId)
    .eq("assigned_user_id", staffGhlUserId)
    .gte("start_time", winStart)
    .lt("start_time", winEnd)
    .in("calendar_id", ["__block__", BREAK_CALENDAR_ID]);

  if (error) {
    console.error(`[reconcile] block reap fetch failed:`, error.message);
    return 0;
  }

  // Base ids GHL returned in composite form this pass, from EITHER feed.
  const supersededBases = new Set();
  for (const id of [...liveBlockIds, ...liveEventIds]) {
    const m = COMPOSITE_ID_RE.exec(id);
    if (m) supersededBases.add(m[1]);
  }

  const doomed = [];
  for (const row of cached || []) {
    if (row.calendar_id === "__block__") {
      // Owned by the blocked-slots fetch — absence is authoritative.
      if (!liveBlockIds.has(row.id)) doomed.push(row);
    } else if (
      // Break-calendar row: absence proves nothing (events feed can page).
      // Only remove the bare-id twin of a composite GHL now returns.
      !COMPOSITE_ID_RE.test(row.id) &&
      !liveEventIds.has(row.id) &&
      supersededBases.has(row.id)
    ) {
      doomed.push(row);
    }
  }

  if (!doomed.length) return 0;

  for (const d of doomed) {
    console.log(
      `[reconcile] ${dryRun ? "(dry) " : ""}REAP block ${d.id} ` +
        `"${(d.title || "").trim() || "(untitled)"}" @ ${d.start_time}`
    );
  }
  if (dryRun) return doomed.length;

  const { error: delErr } = await supabase
    .from("appointments")
    .delete()
    .in(
      "id",
      doomed.map((d) => d.id)
    );
  if (delErr) {
    console.error(`[reconcile] block reap delete failed:`, delErr.message);
    return 0;
  }
  return doomed.length;
}

/**
 * Reconcile ONE staff member's appointments against GHL truth.
 * GHL requires a userId per call (no location-wide fetch — see resolveLocation).
 * @returns {Promise<stats>}
 */
async function reconcileOneStaff({
  locationId,
  sdkInstance,
  staffGhlUserId,
  startTime,
  endTime,
  dryRun,
}) {
  const stats = {
    location: locationId,
    staffGhlUserId,
    range: [startTime, endTime],
    scanned: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    blocksReaped: 0,
    dryRun,
  };

  let events;
  try {
    events = await fetchAppointmentsForDateRange({
      locationId,
      startTime,
      endTime,
      userId: staffGhlUserId,
      sdkInstance,
    });
  } catch (err) {
    console.error(
      `[reconcile] GHL fetch failed for ${staffGhlUserId}:`,
      err.message
    );
    // One staffer's fetch failing shouldn't abort the whole roster sweep.
    stats.errors++;
    return stats;
  }

  // Live GHL ids seen this pass, used by reapDeletedBlocks below.
  // `liveEventIds` covers the appointments/events feed (which is where
  // break-calendar rows come from); `liveBlockIds` covers the separate
  // blocked-slots feed. They are NOT interchangeable — a break-calendar
  // row will never appear in the blocked-slots response and vice versa.
  const liveEventIds = new Set();
  for (const e of events) if (e?.id) liveEventIds.add(e.id);
  const liveBlockIds = new Set();
  let blockFetchOk = false;

  // ── Blocked slots (Phase 3.15e/16e) ─────────────────────────────
  // /calendars/blocked-slots is a SEPARATE endpoint from /events.
  // The "Add Block" UI on the GHL calendar page writes here; these
  // rows do NOT come back from getEvents (verified 2026-06-29 for
  // David's 11:20/1:20 blocks). We fetch them per staff member and
  // merge into the same `events` list so the existing eventToRow +
  // upsert path persists them with calendar_id=null, contact_id=null,
  // which the schedule endpoint's isBlockRow third-signal recognizes.
  // Failure here is non-fatal — block fetch errors shouldn't stop the
  // appointment reconcile (count as one error but keep going).
  try {
    const blockedRes = await sdkInstance.calendars.getBlockedSlots({
      locationId,
      userId: staffGhlUserId,
      startTime: String(new Date(startTime).getTime()),
      endTime: String(new Date(endTime).getTime()),
    });
    const blocks = blockedRes?.events || [];
    // Record the authoritative live set for the reaper below. Only set
    // the OK flag on a successful fetch — an empty array from a real
    // response legitimately means "no blocks", but an exception must
    // never be read as that (see the fail-closed note in reapDeletedBlocks).
    blockFetchOk = true;
    for (const b of blocks) liveBlockIds.add(b.id);
    for (const b of blocks) {
      // Normalize so eventToRow → mapGHLAppointmentToSupabase produces
      // a clean cache row. The cache's `calendar_id` AND `contact_id`
      // columns are both NOT NULL, so we write a sentinel "__block__"
      // for both. The schedule endpoint's isBlockRow recognizes the
      // calendar_id sentinel; that's enough — contact_id sentinel is
      // just to satisfy the schema constraint.
      events.push({
        ...b,
        title: b.title || "Block",
        appointmentStatus: "new",
        calendarId: "__block__",
        contactId: "__block__",
      });
    }
  } catch (err) {
    console.error(
      `[reconcile] blocks fetch failed for ${staffGhlUserId}:`,
      err.message
    );
    stats.errors++;
    // Keep processing appointments — blocks are additive.
  }

  stats.scanned = events.length;

  for (const event of events) {
    const incoming = eventToRow(event);

    if (!incoming.id || !incoming.start_time) {
      stats.skipped++;
      continue;
    }

    try {
      const { data: existing, error: fetchErr } = await supabase
        .from("appointments")
        .select(COMPARE_FIELDS.join(", ") + ", original_start_time, original_end_time")
        .eq("id", incoming.id)
        .maybeSingle();

      if (fetchErr) {
        console.error(`[reconcile] fetch row ${incoming.id}:`, fetchErr.message);
        stats.errors++;
        continue;
      }

      if (!existing) {
        // Missing from cache — a webhook we never received. Insert it.
        if (dryRun) {
          console.log(`[reconcile] (dry) INSERT ${incoming.id} ${incoming.start_time}`);
        } else {
          const row = {
            ...incoming,
            // Preserve creation semantics like handleAppointmentCreated does.
            original_start_time: incoming.start_time,
            original_end_time: incoming.end_time,
            created_at: new Date().toISOString(),
          };
          const { error: insErr } = await supabase
            .from("appointments")
            .insert([row]);
          if (insErr) {
            console.error(`[reconcile] insert ${incoming.id}:`, insErr.message);
            stats.errors++;
            continue;
          }
        }
        stats.inserted++;
      } else if (rowDiffers(incoming, existing)) {
        // Drifted — GHL is truth. Update only the fields we track; do NOT
        // touch reschedule_history/original_* (webhook owns that logic).
        if (dryRun) {
          console.log(`[reconcile] (dry) UPDATE ${incoming.id}`);
        } else {
          const patch = {};
          for (const f of COMPARE_FIELDS) patch[f] = incoming[f];
          patch.ghl_updated_at =
            incoming.ghl_updated_at || new Date().toISOString();
          const { error: updErr } = await supabase
            .from("appointments")
            .update(patch)
            .eq("id", incoming.id);
          if (updErr) {
            console.error(`[reconcile] update ${incoming.id}:`, updErr.message);
            stats.errors++;
            continue;
          }
        }
        stats.updated++;
      } else {
        stats.unchanged++;
      }
    } catch (err) {
      console.error(`[reconcile] row ${incoming.id} failed:`, err.message);
      stats.errors++;
    }
  }

  // Blocks removed in GHL leave no webhook trail, so the only chance to
  // notice they're gone is right here, against the fetch we just made.
  try {
    stats.blocksReaped = await reapDeletedBlocks({
      locationId,
      staffGhlUserId,
      startTime,
      endTime,
      liveBlockIds,
      liveEventIds,
      blockFetchOk,
      dryRun,
    });
  } catch (err) {
    console.error(`[reconcile] block reap threw:`, err.message);
    stats.errors++;
  }

  console.log(
    `[reconcile] ${locationId}${staffGhlUserId ? "/" + staffGhlUserId : ""} ` +
      `${startTime}→${endTime}: scanned=${stats.scanned} ` +
      `ins=${stats.inserted} upd=${stats.updated} same=${stats.unchanged} ` +
      `skip=${stats.skipped} reaped=${stats.blocksReaped} ` +
      `err=${stats.errors}${dryRun ? " (DRY RUN)" : ""}`
  );

  return stats;
}

/** Merge a per-staff stats object into an aggregate. */
function accumulate(agg, s) {
  agg.scanned += s.scanned;
  agg.inserted += s.inserted;
  agg.updated += s.updated;
  agg.unchanged += s.unchanged;
  agg.skipped += s.skipped;
  agg.errors += s.errors;
  agg.blocksReaped += s.blocksReaped || 0;
  agg.perStaff.push({
    staffGhlUserId: s.staffGhlUserId,
    scanned: s.scanned,
    inserted: s.inserted,
    updated: s.updated,
    blocksReaped: s.blocksReaped || 0,
    errors: s.errors,
  });
}

/**
 * Public entry point. Reconcile cached appointments against GHL truth.
 *
 * - With `staffGhlUserId`: reconcile just that barber/artist (Refresh button).
 * - Without it: loop the location's full roster from kioskConfig.js
 *   (launch backfill / periodic sweep). GHL has no location-wide events
 *   fetch, so the loop is mandatory, not an optimization.
 *
 * @param {object} opts
 * @param {string} opts.location          "barbershop" | "tattoo" | raw locationId
 * @param {string} [opts.staffGhlUserId]  optional — scope to one barber/artist
 * @param {string|number|Date} opts.fromDate
 * @param {string|number|Date} opts.toDate
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<stats>}  aggregate (with .perStaff[] when roster-wide)
 */
async function reconcileAppointments({
  location,
  staffGhlUserId = null,
  fromDate,
  toDate,
  dryRun = false,
}) {
  if (!supabase) {
    throw new Error("reconcileAppointments: Supabase client not configured");
  }
  const { locationId, sdkInstance, roster } = resolveLocation(location);
  const startTime = new Date(fromDate).toISOString();
  const endTime = new Date(toDate).toISOString();

  // Single-staff scope (Refresh button) — one GHL call.
  if (staffGhlUserId) {
    const s = await reconcileOneStaff({
      locationId,
      sdkInstance,
      staffGhlUserId,
      startTime,
      endTime,
      dryRun,
    });
    // A completed real reconcile proves the GHL→cache path works → heartbeat.
    if (!dryRun && s.errors === 0) {
      const { touchHeartbeat } = require("./syncHeartbeat");
      touchHeartbeat(locationId, "reconciler", `staff ${staffGhlUserId}`);
    }
    return s;
  }

  // Roster-wide scope (backfill / sweep) — one GHL call per staff member.
  const agg = {
    location: locationId,
    range: [startTime, endTime],
    scanned: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    blocksReaped: 0,
    dryRun,
    perStaff: [],
  };

  for (const member of roster) {
    const s = await reconcileOneStaff({
      locationId,
      sdkInstance,
      staffGhlUserId: member.ghlUserId,
      startTime,
      endTime,
      dryRun,
    });
    accumulate(agg, s);
  }

  console.log(
    `[reconcile] ${locationId} ROSTER (${roster.length} staff) ` +
      `${startTime}→${endTime}: scanned=${agg.scanned} ins=${agg.inserted} ` +
      `upd=${agg.updated} same=${agg.unchanged} skip=${agg.skipped} ` +
      `reaped=${agg.blocksReaped} err=${agg.errors}${dryRun ? " (DRY RUN)" : ""}`
  );
  // A completed sweep is the FIXED-CADENCE proof-of-life (advances the
  // heartbeat even on a zero-booking day — the whole point). Touch even
  // if some staff errored, as long as the sweep ran and mostly succeeded.
  if (!dryRun && agg.errors < roster.length) {
    const { touchHeartbeat } = require("./syncHeartbeat");
    touchHeartbeat(
      locationId,
      "reconciler",
      `sweep ${roster.length} staff, ins=${agg.inserted} upd=${agg.updated} err=${agg.errors}`
    );
  }
  return agg;
}

/** Convenience: reconcile both locations for a relative day window. */
async function reconcileAllLocations({
  pastDays = 1,
  futureDays = 60,
  dryRun = false,
} = {}) {
  const fromDate = Date.now() - pastDays * MS_PER_DAY;
  const toDate = Date.now() + futureDays * MS_PER_DAY;
  const out = {};
  for (const location of ["barbershop", "tattoo"]) {
    out[location] = await reconcileAppointments({
      location,
      fromDate,
      toDate,
      dryRun,
    });
  }
  return out;
}

module.exports = { reconcileAppointments, reconcileAllLocations };
