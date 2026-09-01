// ============================================================================
// partialLeadNudgeLoop — raise a Command Center task for the front desk when
// someone starts the consultation form, hands over a phone number, and never
// finishes.
//
// /lead/partial writes a row the moment we have contact details. /lead/final
// stamps completed_at. Anything still unstamped after NUDGE_AFTER_MS is a lead
// who walked away mid-form — a warm name with nobody chasing it. Before this,
// nothing anywhere told a human that had happened.
//
// Why a delay instead of notifying on every partial: most people finish the
// form within a minute or two, so an immediate alert is mostly noise about
// leads that are about to convert on their own. The delay is what turns this
// into a signal.
//
// Follows the alert-loop rules this repo learned the hard way:
//  - Debounce is a DB column (nudged_at), never memory — it survives deploys.
//  - CLAIM BEFORE SEND: stamp nudged_at where it is still NULL and only act on
//    rows we actually claimed. Two instances, or overlapping ticks, cannot
//    both raise the task. A crash between claim and send costs one nudge
//    (fail-closed), never a duplicate.
//  - MAX_AGE_MS stops a first deploy (or a long outage) from dumping every
//    historical partial into the front desk's queue at once.
// ============================================================================

const { supabase } = require("../clients/supabaseClient");
const { createCommandCenterTask, TASK_TYPES } = require("../clients/commandCenter");
const { GHL_USER_IDS } = require("../config/constants");

const TICK_MS = 5 * 60 * 1000; // 5 min
const NUDGE_AFTER_MS = 20 * 60 * 1000; // give them 20 min to finish on their own
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // never nudge on anything older than a day

/** Record that someone reached the contact-details step. Idempotent. */
async function recordPartialLead({ contactId, contactName, phone, email, locationId }) {
  if (!supabase || !contactId) return;
  try {
    // ignoreDuplicates: a returning lead re-submitting a partial must NOT
    // reset the clock or resurrect a row we already completed or nudged.
    const { error } = await supabase
      .from("partial_lead_nudges")
      .upsert(
        {
          contact_id: contactId,
          contact_name: contactName || null,
          phone: phone || null,
          email: email || null,
          location_id: locationId || null,
        },
        { onConflict: "contact_id", ignoreDuplicates: true }
      );
    if (error) throw error;
  } catch (err) {
    // Never let the ledger break the lead submission itself.
    console.error(`⚠️ [PARTIAL NUDGE] record failed for ${contactId}:`, err.message || err);
  }
}

/**
 * Mark the form finished so the loop leaves this contact alone, and retire any
 * nudge task already raised for them.
 *
 * The second half matters: the nudge fires at 20 minutes, but people do come
 * back and finish afterwards — the first one live did, four minutes later. Left
 * alone, the front desk is holding a task telling them to chase someone who has
 * already converted, which is worse than no task at all. Dismissed rather than
 * completed: nobody did the work, the reason for it went away.
 */
async function resolvePartialLead(contactId) {
  if (!supabase || !contactId) return;
  try {
    await supabase
      .from("partial_lead_nudges")
      .update({ completed_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .is("completed_at", null);
  } catch (err) {
    console.error(`⚠️ [PARTIAL NUDGE] resolve failed for ${contactId}:`, err.message || err);
  }

  try {
    const { data: retired } = await supabase
      .from("command_center_tasks")
      .update({ status: "dismissed" })
      .eq("contact_id", contactId)
      .eq("type", TASK_TYPES.PARTIAL_LEAD_FOLLOWUP)
      .in("status", ["pending", "overdue", "urgent"])
      .select("id");
    if (retired?.length) {
      console.log(
        `🪝 [PARTIAL NUDGE] ${contactId} finished the form — retired ${retired.length} stale task(s)`
      );
    }
  } catch (err) {
    console.error(`⚠️ [PARTIAL NUDGE] task retire failed for ${contactId}:`, err.message || err);
  }
}

async function sweepOnce(now = new Date()) {
  if (!supabase) return;

  const cutoff = new Date(now.getTime() - NUDGE_AFTER_MS).toISOString();
  const floor = new Date(now.getTime() - MAX_AGE_MS).toISOString();

  const { data: stalled, error } = await supabase
    .from("partial_lead_nudges")
    .select("contact_id, contact_name, phone, location_id, created_at")
    .is("nudged_at", null)
    .is("completed_at", null)
    .lte("created_at", cutoff)
    .gte("created_at", floor);

  if (error) {
    console.error("❌ [PARTIAL NUDGE] query failed:", error.message);
    return;
  }

  for (const row of stalled || []) {
    // Atomic claim: stamp first, act only on what we stamped.
    const { data: claimed, error: claimErr } = await supabase
      .from("partial_lead_nudges")
      .update({ nudged_at: new Date().toISOString() })
      .eq("contact_id", row.contact_id)
      .is("nudged_at", null)
      .is("completed_at", null)
      .select("contact_id");

    if (claimErr || !claimed || claimed.length === 0) continue;

    const minutesStalled = Math.max(1, Math.round((now - new Date(row.created_at)) / 60000));
    const contactName = row.contact_name || "New lead";

    try {
      await createCommandCenterTask({
        type: TASK_TYPES.PARTIAL_LEAD_FOLLOWUP,
        contactId: row.contact_id,
        contactName,
        assignedTo: [GHL_USER_IDS.MARIA],
        triggerEvent: "partial_lead_stalled",
        locationId: row.location_id || process.env.GHL_LOCATION_ID,
        metadata: {
          minutes_stalled: minutesStalled,
          phone: row.phone || null,
          started_at: row.created_at,
        },
      });
      console.log(
        `🪝 [PARTIAL NUDGE] task raised for ${contactName} (${row.contact_id}) — ` +
          `stalled ${minutesStalled}min`
      );
    } catch (err) {
      // Claim already stamped — deliberate: fail-closed beats a duplicate task.
      console.error(`❌ [PARTIAL NUDGE] task failed for ${row.contact_id}:`, err.message || err);
    }
  }
}

function startPartialLeadNudgeLoop() {
  console.log(
    `🪝 [PARTIAL NUDGE] loop started — tick ${TICK_MS / 60000}min, ` +
      `nudge after ${NUDGE_AFTER_MS / 60000}min stalled`
  );
  sweepOnce().catch((err) => console.error("❌ [PARTIAL NUDGE] initial sweep:", err.message));
  setInterval(() => {
    sweepOnce().catch((err) => console.error("❌ [PARTIAL NUDGE] sweep:", err.message));
  }, TICK_MS);
}

module.exports = {
  startPartialLeadNudgeLoop,
  recordPartialLead,
  resolvePartialLead,
  sweepOnce,
  NUDGE_AFTER_MS,
};
