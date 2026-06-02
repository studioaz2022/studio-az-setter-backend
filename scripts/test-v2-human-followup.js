#!/usr/bin/env node
// test-v2-human-followup.js — Phase 4 verification: human detection + decay + smart resume + followups.
//
// Deterministic asserts: human-in-thread detection, 24h decay math (auto-extend, resume gate),
//   parseWhen, graceful no-op when scheduled_followups table is absent.
// Live (Haiku): smartResumeCheck (open vs wrapped), draftFollowupMessage (references convo).
//
// override:true — dev shell shadows ANTHROPIC_API_KEY.
require("dotenv").config({ override: true, quiet: true });

const hd = require("../src/ai/v2/humanDetection");
const { smartResumeCheck } = require("../src/ai/v2/resumeNotifier");
const fu = require("../src/ai/v2/followupScheduler");
const { supabase } = require("../src/clients/supabaseClient");

const HOUR = 3600000, DAY = 24 * HOUR;
const iso = (msAgo, now) => new Date(now - msAgo).toISOString();

let pass = 0, total = 0;
function check(name, cond) { total++; if (cond) { pass++; console.log(`  ✅ ${name}`); } else console.log(`  ❌ ${name}`); }

(async () => {
  const NOW = Date.parse("2026-06-02T18:00:00Z");

  console.log("── Signal A: human-in-thread detection ──");
  const botMsg = { direction: "outbound", source: "workflow", dateAdded: iso(2 * HOUR, NOW) };
  const humanApp = { direction: "outbound", source: "app", userId: "staff123", dateAdded: iso(1 * HOUR, NOW) };
  const humanUserId = { direction: "outbound", source: "", userId: "staff999", dateAdded: iso(30 * 60000, NOW) };
  const leadMsg = { direction: "inbound", dateAdded: iso(10 * 60000, NOW) };
  check("bot-only thread → no human", !hd.analyzeThread([botMsg, leadMsg]).humanInThread);
  check("source:app outbound → human", hd.analyzeThread([botMsg, humanApp]).humanInThread);
  check("outbound w/ non-bot userId → human", hd.analyzeThread([humanUserId]).humanInThread);
  check("bot userId outbound → NOT human", !hd.isHumanMessage({ direction: "outbound", userId: hd.AI_BOT_USER_ID }));
  // Regression (real GHL data): the bot sends with source "app" AND its own userId — must NOT
  // be seen as a human, or the bot silences itself after its own messages.
  check("bot msg source:app + bot userId → NOT human", !hd.isHumanMessage({ direction: "outbound", source: "app", userId: hd.AI_BOT_USER_ID }));
  check("staff msg source:app + other userId → human", hd.isHumanMessage({ direction: "outbound", source: "app", userId: "Wl24x1ZrucHuHatM0ODD" }));
  check("workflow automation → NOT human", !hd.isHumanMessage({ direction: "outbound", source: "workflow", userId: "Wl24x1ZrucHuHatM0ODD" }));

  console.log("\n── Signal B: 24h decay window ──");
  const d1 = hd.evaluateDecay({ lastActivityAt: iso(1 * HOUR, NOW), now: NOW });
  check("activity 1h ago → within decay, no resume", d1.withinDecay && !d1.shouldCheckResume);
  const d2 = hd.evaluateDecay({ lastActivityAt: iso(25 * HOUR, NOW), now: NOW });
  check("activity 25h ago → decay expired, check resume", !d2.withinDecay && d2.shouldCheckResume);
  // Auto-extend: a recent message (either side) keeps the window open even if human spoke long ago.
  const extend = hd.evaluateBackoff({ messages: [humanApp /*1h ago*/, { direction: "inbound", dateAdded: iso(30 * 60000, NOW) }], now: NOW });
  check("auto-extend: human 1h ago + lead 30m ago → stay_silent", extend.decision === "stay_silent");
  // Both silent 25h after a human reply → check_resume.
  const expired = hd.evaluateBackoff({ messages: [{ direction: "outbound", source: "app", dateAdded: iso(25 * HOUR, NOW) }], now: NOW });
  check("both silent 25h → check_resume", expired.decision === "check_resume");
  check("no human in thread → proceed", hd.evaluateBackoff({ messages: [botMsg, leadMsg], now: NOW }).decision === "proceed");

  console.log("\n── Followups: parseWhen + live persistence (table applied 2026-06-02) ──");
  const w = fu.parseWhen("2 days", NOW);
  check("parseWhen('2 days') ≈ +2d", Math.abs(w.getTime() - (NOW + 2 * DAY)) < 1000);
  check("parseWhen('1 week') ≈ +7d", Math.abs(fu.parseWhen("1 week", NOW).getTime() - (NOW + 7 * DAY)) < 1000);
  const sched = await fu.scheduleFollowup({ contactId: "TEST_HF", when: "2 days", message: "[TEST_HF] still thinking about that forearm piece?" });
  check("scheduleFollowup persists to live table", sched && sched.ok === true && !!sched.id);
  const swept = await fu.processDueFollowups({ now: NOW, send: async () => {} });
  check("processDueFollowups runs (future row not due → 0)", swept && swept.processed === 0);
  if (supabase) await supabase.from("scheduled_followups").delete().eq("contact_id", "TEST_HF"); // cleanup

  console.log("\n── Signal C: smart resume check (live Haiku) ──");
  const openThread = [
    { direction: "inbound", body: "do you have anything thursday for a forearm piece?" },
    { direction: "outbound", source: "app", body: "let me check with the artist and get back to you" },
  ];
  const wrappedThread = [
    { direction: "inbound", body: "perfect, thanks so much!" },
    { direction: "outbound", source: "app", body: "you got it — see you thursday at 3!" },
  ];
  const openRes = await smartResumeCheck(openThread);
  const wrapRes = await smartResumeCheck(wrappedThread);
  console.log(`  open thread   → open=${openRes.open}  "${openRes.reasoning}"`);
  console.log(`  wrapped thread→ open=${wrapRes.open}  "${wrapRes.reasoning}"`);
  check("smart resume: hanging question → open", openRes.open === true);
  check("smart resume: wrapped up → stay silent", wrapRes.open === false);

  console.log("\n── Followup drafting (live Haiku) ──");
  const draft = await fu.draftFollowupMessage({
    history: [
      { role: "user", content: "i want a forearm piece but need to save up a bit" },
      { role: "assistant", content: "totally — want me to follow up in a couple weeks?" },
    ],
    reason: "lead needs to save up",
  });
  console.log(`  draft: "${draft.message}"`);
  check("draft references the forearm/saving context", /forearm|save|saving|piece/i.test(draft.message));

  console.log("\n" + "=".repeat(56));
  console.log(`Phase 4 checks: ${pass}/${total} passed`);
  console.log("=".repeat(56) + "\n");
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
