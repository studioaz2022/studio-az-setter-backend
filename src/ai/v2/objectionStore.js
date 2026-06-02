// objectionStore.js — append-only log of detected objections (Phase 3).
//
// Every time the bot detects an objection (escalation flags one), we record it: which
// objection, the lead's exact message, the bot's reply, the model used. After ~2 weeks of
// real traffic this table drives the Phase 6 tuning checkpoint:
//   "did the right objection get detected? did the reply land or feel canned? did the lead
//    progress or fall off?"
//
// Best-effort and fully isolated (mirrors shadowStore): if Supabase is missing or the table
// doesn't exist yet, it logs and moves on — it must never disturb the conversation.
//
// NOTE: the objection_events table migration is authored but NOT YET APPLIED (awaiting
// approval). Until applied, every write here is a graceful no-op.

const { supabase } = require("../../clients/supabaseClient");

/**
 * Record a detected-objection event. Never throws.
 * @param {object} row
 * @returns {Promise<boolean>} true if written
 */
async function recordObjectionEvent(row) {
  if (!supabase) return false;
  try {
    const record = {
      contact_id: row.contactId || null,
      contact_name: row.contactName || null,
      objection_id: row.objectionId || null,
      escalation_reason: row.escalationReason || null,
      message_text: row.messageText || null,
      bot_reply: row.botReply || null,
      model_used: row.modelUsed || null,
      language: row.language || null,
      outcome: row.outcome || null, // filled in later: deposit_paid | went_cold | human_took_over
    };
    const { error } = await supabase.from("objection_events").insert([record]);
    if (error) {
      // Table-missing is expected until the migration is applied — keep it quiet-ish.
      console.error("🗣️ [OBJECTION LOG] persist skipped:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("🗣️ [OBJECTION LOG] persist threw (ignored):", err.message || err);
    return false;
  }
}

module.exports = { recordObjectionEvent };
