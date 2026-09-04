// firefliesCleanup.js
// Reclaims Fireflies storage by deleting meetings we have already archived.
//
// WHY THIS RUNS AT ALL
// --------------------
// Fireflies caps storage in MINUTES of stored recordings (400/seat, pooled) —
// a total cap that never resets, not a monthly allowance. The account hit 100%
// on 2026-09-04, at which point new meetings are captured but may not be
// retrievable, which would silently break the consult→GHL pipeline.
//
// An endpoint to do this has existed since the integration was built, with a
// comment saying "call weekly via cron or manually". It was never wired to a
// scheduler and was never once called — every row still read `processed`, none
// read `deleted`. That is the specific failure this module exists to prevent:
// a retention policy that is written down but never runs is the same as no
// retention policy.
//
// THE INVARIANT
// -------------
// Never delete from Fireflies what we do not hold ourselves. Eligibility
// requires transcript_text to be non-null in Supabase — the archived copy of
// the words. Meetings that never reached the webhook have no row at all and are
// therefore invisible here; they must be rescued by /api/fireflies/backfill
// first. The sweep reports how many it skipped for this reason so a stalled
// backfill is visible rather than quietly shrinking each run.

const { createClient } = require("@supabase/supabase-js");
const { batchDeleteTranscripts } = require("../clients/firefliesClient");

const TAG = "🧹 [FirefliesCleanup]";

// Consults stay commercially live for weeks while an artist works up a design,
// so 60 days rather than the original 7. The transcript survives either way —
// retention only governs how long the Fireflies-side recording sticks around.
const DEFAULT_RETAIN_DAYS = 60;

let supabase = null;
function db() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  supabase = createClient(url, key);
  return supabase;
}

/**
 * Delete archived transcripts older than the retention window.
 *
 * @param {object} [opts]
 * @param {number} [opts.retainDays=60]
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<object>} summary
 */
async function runCleanupSweep({ retainDays = DEFAULT_RETAIN_DAYS, dryRun = false } = {}) {
  const sb = db();
  if (!sb) return { success: false, error: "Supabase not configured" };

  const days = Math.max(7, Math.min(Number(retainDays) || DEFAULT_RETAIN_DAYS, 365));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  console.log(`${TAG} Sweep — retaining ${days} days${dryRun ? " (dry run)" : ""}`);

  const { data: eligible, error: queryErr } = await sb
    .from("fireflies_transcripts")
    .select("transcript_id, meeting_title, meeting_date, duration_minutes")
    .in("status", ["processed", "skipped_google_exists", "unmatched"])
    .not("transcript_text", "is", null)
    .lt("meeting_date", cutoff);

  if (queryErr) {
    console.error(`${TAG} Query failed:`, queryErr.message);
    return { success: false, error: queryErr.message };
  }

  // Anything past the window we cannot safely touch — the backfill's queue.
  const { count: skippedUnarchived } = await sb
    .from("fireflies_transcripts")
    .select("transcript_id", { count: "exact", head: true })
    .is("transcript_text", null)
    .lt("meeting_date", cutoff);

  const minutes = (eligible || []).reduce(
    (a, r) => a + (Number(r.duration_minutes) || 0),
    0
  );

  if (!eligible || eligible.length === 0) {
    console.log(`${TAG} Nothing eligible (${skippedUnarchived || 0} unarchived and skipped)`);
    return {
      success: true,
      deleted: 0,
      eligible: 0,
      skippedUnarchived: skippedUnarchived || 0,
    };
  }

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      eligible: eligible.length,
      minutesReclaimable: Math.round(minutes),
      skippedUnarchived: skippedUnarchived || 0,
      items: eligible.map((r) => ({
        id: r.transcript_id,
        title: r.meeting_title,
        date: r.meeting_date ? r.meeting_date.slice(0, 10) : null,
        minutes: r.duration_minutes,
      })),
    };
  }

  const ids = eligible.map((r) => r.transcript_id);
  console.log(`${TAG} Deleting ${ids.length} archived transcripts (~${Math.round(minutes)} min)`);

  const deletedCount = await batchDeleteTranscripts(ids);

  const { error: updateErr } = await sb
    .from("fireflies_transcripts")
    .update({ status: "deleted", deleted_at: new Date().toISOString() })
    .in("transcript_id", ids);

  if (updateErr) console.error(`${TAG} Status update failed:`, updateErr.message);

  console.log(
    `${TAG} Done: ${deletedCount}/${ids.length} deleted, ~${Math.round(minutes)} min reclaimed`
  );

  return {
    success: true,
    deleted: deletedCount,
    eligible: ids.length,
    minutesReclaimed: Math.round(minutes),
    skippedUnarchived: skippedUnarchived || 0,
  };
}

module.exports = { runCleanupSweep, DEFAULT_RETAIN_DAYS };
