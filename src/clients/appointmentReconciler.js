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

  console.log(
    `[reconcile] ${locationId}${staffGhlUserId ? "/" + staffGhlUserId : ""} ` +
      `${startTime}→${endTime}: scanned=${stats.scanned} ` +
      `ins=${stats.inserted} upd=${stats.updated} same=${stats.unchanged} ` +
      `skip=${stats.skipped} err=${stats.errors}${dryRun ? " (DRY RUN)" : ""}`
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
  agg.perStaff.push({
    staffGhlUserId: s.staffGhlUserId,
    scanned: s.scanned,
    inserted: s.inserted,
    updated: s.updated,
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
      `err=${agg.errors}${dryRun ? " (DRY RUN)" : ""}`
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
