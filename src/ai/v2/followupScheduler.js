// followupScheduler.js — v2 touch-back follow-ups (Phase 4). Replaces the v1 scheduler, simpler.
//
// Stores future-dated reminders in Supabase (scheduled_followups) and a cron sweep sends them
// when due. Cadence: 2d → 7d → 21d → drop. The reopening message is LLM-drafted to reference
// what the lead actually said ("hey — were you still thinking about that forearm piece?").
//
// Best-effort: every DB call is guarded and never throws. Until the scheduled_followups
// migration is applied, scheduling/processing are graceful no-ops.

const { supabase } = require("../../clients/supabaseClient");
const { generateReply, MODELS } = require("./anthropicClient");
const { sendConversationMessage } = require("../../clients/ghlClient");

// Cadence in days per step (1-indexed). After the last step we drop.
const CADENCE_DAYS = { 1: 2, 2: 7, 3: 21 };
const MAX_CADENCE_STEP = 3;

/** Parse a loose "when" string ("2 days", "in a week", "3d") into a future Date. */
function parseWhen(when, from = Date.now()) {
  if (when instanceof Date) return when;
  if (typeof when === "number") return new Date(from + when);
  const s = String(when || "").toLowerCase().trim();
  const m = s.match(/(\d+)\s*(hour|hr|h|day|d|week|w)/);
  if (!m) return new Date(from + CADENCE_DAYS[1] * 86400000); // default 2 days
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit.startsWith("h") ? n * 3600000 : unit.startsWith("w") ? n * 7 * 86400000 : n * 86400000;
  return new Date(from + ms);
}

/**
 * Draft a reopening follow-up message in the bot's voice, referencing the conversation.
 * @param {object} args { history, language, reason }
 * @returns {Promise<{message:string, model:string}>}
 */
async function draftFollowupMessage({ history = [], language = "en", reason = "" } = {}) {
  const transcript = (history || [])
    .slice(-10)
    .map((m) => `${m.role === "assistant" ? "BOT" : "LEAD"}: ${(m.content || m.text || "").toString().trim()}`)
    .filter((l) => l.length > 5)
    .join("\n");

  const sys =
    "You write ONE short, warm follow-up text for a tattoo studio lead who went quiet. " +
    "Reference what they actually said — never a generic 'just checking in'. Casual, lowercase ok, " +
    "one short message, no pressure. No emojis. " +
    (language === "es" ? "Write in Spanish." : "Write in English.") +
    " Output only the message text.";
  const user = `Conversation so far:\n${transcript || "(brief)"}\n${reason ? `\nWhy following up: ${reason}` : ""}\n\nWrite the follow-up:`;

  try {
    const res = await generateReply({ system: sys, messages: [{ role: "user", content: user }], model: MODELS.HAIKU, maxTokens: 120, temperature: 0.7 });
    return { message: res.text.trim(), model: res.model };
  } catch (err) {
    console.error("[followupScheduler] draft error:", err.message);
    return { message: "", model: null };
  }
}

/**
 * Schedule a follow-up. Never throws.
 * @param {object} args { contactId, when, message, cadenceStep, reason, model }
 * @returns {Promise<{ok:boolean, id?:string, scheduledFor?:string, error?:string}>}
 */
async function scheduleFollowup({ contactId, when, message, cadenceStep = 1, reason = "", model = null } = {}) {
  if (!contactId || !message) return { ok: false, error: "contactId and message required" };
  if (!supabase) return { ok: false, error: "supabase not configured" };
  const scheduledFor = parseWhen(when);
  try {
    const { data, error } = await supabase
      .from("scheduled_followups")
      .insert([{
        contact_id: contactId,
        scheduled_for: scheduledFor.toISOString(),
        message,
        cadence_step: cadenceStep,
        reason,
        drafted_by_model: model,
        status: "pending",
      }])
      .select("id")
      .single();
    if (error) {
      console.error("[followupScheduler] schedule skipped:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data?.id, scheduledFor: scheduledFor.toISOString() };
  } catch (err) {
    console.error("[followupScheduler] schedule threw:", err.message);
    return { ok: false, error: err.message };
  }
}

/** Cancel pending follow-ups for a contact (called when they re-engage / pay / human takes over). */
async function cancelFollowups(contactId, cancelReason = "lead re-engaged") {
  if (!supabase || !contactId) return 0;
  try {
    const { data, error } = await supabase
      .from("scheduled_followups")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: cancelReason })
      .eq("contact_id", contactId)
      .eq("status", "pending")
      .select("id");
    if (error) { console.error("[followupScheduler] cancel skipped:", error.message); return 0; }
    return (data || []).length;
  } catch (err) {
    console.error("[followupScheduler] cancel threw:", err.message);
    return 0;
  }
}

/**
 * Cron sweep: send all due pending follow-ups. Never throws.
 * @param {object} [opts] { now, limit, send } — `send` injectable for tests (defaults to GHL send)
 * @returns {Promise<{processed:number, sent:number, failed:number}>}
 */
async function processDueFollowups({ now = Date.now(), limit = 50, send = null } = {}) {
  if (!supabase) return { processed: 0, sent: 0, failed: 0 };
  const sender = send || ((contactId, body) => sendConversationMessage({ contactId, body }));
  let processed = 0, sent = 0, failed = 0;
  try {
    const { data, error } = await supabase
      .from("scheduled_followups")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_for", new Date(now).toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(limit);
    if (error) { console.error("[followupScheduler] sweep query failed:", error.message); return { processed: 0, sent: 0, failed: 0 }; }

    for (const fu of data || []) {
      processed++;
      try {
        await sender(fu.contact_id, fu.message);
        await supabase.from("scheduled_followups").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", fu.id);
        sent++;
      } catch (err) {
        console.error(`[followupScheduler] send failed for ${fu.id}:`, err.message);
        failed++;
      }
    }
  } catch (err) {
    console.error("[followupScheduler] sweep threw:", err.message);
  }
  return { processed, sent, failed };
}

module.exports = {
  parseWhen,
  draftFollowupMessage,
  scheduleFollowup,
  cancelFollowups,
  processDueFollowups,
  CADENCE_DAYS,
  MAX_CADENCE_STEP,
};
