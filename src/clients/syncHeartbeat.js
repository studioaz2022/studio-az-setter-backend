/**
 * Sync heartbeat — proof-of-life for the GHL→Supabase appointment cache.
 *
 * Touched from the two places that PROVE the pipeline is working:
 *   - the /webhooks/ghl/appointments handler (event-driven), and
 *   - the periodic reconciler sweep (fixed cadence — guarantees the
 *     heartbeat advances even on a zero-booking day).
 *
 * The front-desk /schedule endpoint reads it to decide `stale`. See
 * FRONT_DESK_DASHBOARD_PLAN.md Section 10. Best-effort: a heartbeat
 * failure must never break the webhook or the sweep, so all errors here
 * are swallowed (logged, not thrown).
 */

const { supabase } = require("./supabaseClient");

/**
 * Record proof the pipeline is alive for a location.
 * @param {string} locationId  GHL location id
 * @param {"webhook"|"reconciler"} source
 * @param {string} [detail]    optional context (event type / sweep stats)
 */
async function touchHeartbeat(locationId, source, detail) {
  if (!supabase || !locationId) return;
  try {
    await supabase.from("sync_heartbeat").upsert(
      {
        location_id: locationId,
        last_beat_at: new Date().toISOString(),
        source,
        detail: detail ? String(detail).slice(0, 200) : null,
      },
      { onConflict: "location_id" }
    );
  } catch (err) {
    console.warn("[heartbeat] touch failed (non-fatal):", err.message);
  }
}

/**
 * Newest heartbeat instant for a location, or null if none yet.
 * @returns {Promise<string|null>} ISO timestamp
 */
async function getHeartbeat(locationId) {
  if (!supabase || !locationId) return null;
  try {
    const { data } = await supabase
      .from("sync_heartbeat")
      .select("last_beat_at")
      .eq("location_id", locationId)
      .maybeSingle();
    return data ? data.last_beat_at : null;
  } catch (err) {
    console.warn("[heartbeat] read failed (non-fatal):", err.message);
    return null;
  }
}

module.exports = { touchHeartbeat, getHeartbeat };
