// resumeNotifier.js — Signal C of the back-off system + the resume approval push (Phase 4).
//
// When the 24h decay window has elapsed on a paused_human thread (per humanDetection), we don't
// just barge back in. First a cheap Haiku call decides whether the conversation is still OPEN
// or WRAPPED UP. If open, we draft the first message and push an iOS approval notification
// (Approve / Block once / Pause AI) with a 5-minute default window — if you don't respond, it
// sends. This gives a final human say on the resume moment without approving every routine reply.
//
// Both functions are best-effort and never throw — the back-off system must never crash the flow.

const fs = require("fs");
const path = require("path");
const { generateReply, MODELS } = require("./anthropicClient");
const { supabase } = require("../../clients/supabaseClient");

const RESUME_PROMPT_PATH = path.join(__dirname, "..", "..", "prompts", "v4", "resume_check_prompt.md");
let RESUME_PROMPT = "";
try {
  RESUME_PROMPT = fs.readFileSync(RESUME_PROMPT_PATH, "utf8");
} catch (err) {
  console.error(`❌ [resumeNotifier] failed to load resume prompt:`, err.message);
}

const APPROVAL_WINDOW_MINUTES = 5;

/** Render a compact transcript for the resume check. */
function renderThread(messages = []) {
  return (messages || [])
    .slice(-12)
    .map((m) => {
      const who = m.direction === "inbound" ? "LEAD" : (m.source || "").toLowerCase() === "app" ? "STAFF" : "BOT";
      return `${who}: ${(m.body || m.content || "").toString().trim()}`;
    })
    .filter((l) => l.length > 6)
    .join("\n");
}

/**
 * Signal C: is the paused conversation still open (resume) or wrapped up (stay silent)?
 * Never throws — on any error returns { open:false } (fail safe = don't barge in).
 * @param {Array} messages recent thread messages
 * @returns {Promise<{open:boolean, reasoning:string, _error?:boolean}>}
 */
async function smartResumeCheck(messages = []) {
  if (!RESUME_PROMPT) return { open: false, reasoning: "resume prompt not loaded", _error: true };
  const transcript = renderThread(messages);
  if (!transcript) return { open: false, reasoning: "no transcript to evaluate" };
  try {
    const res = await generateReply({
      system: RESUME_PROMPT,
      messages: [{ role: "user", content: `Conversation so far:\n\n${transcript}\n\nIs this still open?` }],
      model: MODELS.HAIKU,
      maxTokens: 150,
      temperature: 0,
    });
    let parsed;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      // tolerate code fences / stray text
      const m = res.text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed || typeof parsed.open !== "boolean") {
      return { open: false, reasoning: "unparseable resume verdict", _error: true };
    }
    return { open: parsed.open, reasoning: parsed.reasoning || "" };
  } catch (err) {
    console.error("[resumeNotifier] smartResumeCheck error:", err.message);
    return { open: false, reasoning: `resume check error: ${err.message}`, _error: true };
  }
}

/**
 * Push an iOS approval notification before the bot breaks a pause. Never throws.
 * @param {object} args { contactId, contactName, draftMessage }
 * @returns {Promise<boolean>} true if the notification was written
 */
async function pushResumeApproval({ contactId, contactName, draftMessage } = {}) {
  if (!supabase) return false;
  const notification = {
    contact_id: contactId || null,
    notification_type: "ai_resume_approval",
    title: `AI Setter resuming with ${contactName || "lead"}`,
    body: draftMessage || "",
    data: {
      draft_message: draftMessage || "",
      actions: ["approve", "block_once", "pause_ai"],
      approval_window_minutes: APPROVAL_WINDOW_MINUTES,
      default_action: "approve", // sends if no response within the window
    },
    read: false,
    priority: "high",
    created_at: new Date().toISOString(),
  };
  try {
    const { error } = await supabase.from("notifications").insert([notification]);
    if (error) {
      console.error("[resumeNotifier] push failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[resumeNotifier] push threw:", err.message);
    return false;
  }
}

module.exports = { smartResumeCheck, pushResumeApproval, renderThread, APPROVAL_WINDOW_MINUTES };
