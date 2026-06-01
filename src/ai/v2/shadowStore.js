// shadowStore.js — append-only persistence for v2 funnel-gate shadow decisions (Phase 0.5).
//
// Writes one row per shadow decision into the shadow_decisions table so we can audit
// the gate against real traffic before it drives anything. Best-effort and fully
// isolated: if Supabase is missing or the insert fails, it logs and moves on — it must
// never disturb the live webhook (shadow mode is a passive observer).

const { supabase } = require("../../clients/supabaseClient");

/**
 * Persist a shadow decision. Never throws.
 * @param {object} row see shape below
 * @returns {Promise<boolean>} true if written
 */
async function recordShadowDecision(row) {
  if (!supabase) return false; // creds not configured — skip silently
  try {
    const record = {
      contact_id: row.contactId || null,
      contact_name: row.contactName || null,
      location_id: row.locationId || null,
      location_reason: row.locationReason || null,
      entry_source: row.entrySource || null,
      message_text: row.messageText || null,
      shadow_stage: row.shadowStage || null,
      funnel_status_current: row.funnelStatusCurrent || null,
      action: row.action || null,
      notify_human: !!row.notifyHuman,
      reason: row.reason || null,
      ran_classifier: !!row.ranClassifier,
      classifier: row.classifier || null,
      proposed: row.proposed && Object.keys(row.proposed).length ? row.proposed : null,
    };
    const { error } = await supabase.from("shadow_decisions").insert([record]);
    if (error) {
      console.error("🕵️ [SHADOW] persist failed (ignored):", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("🕵️ [SHADOW] persist threw (ignored):", err.message || err);
    return false;
  }
}

module.exports = { recordShadowDecision };
