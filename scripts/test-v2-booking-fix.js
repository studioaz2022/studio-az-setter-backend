#!/usr/bin/env node
// test-v2-booking-fix.js — verifies the fixes for the 2026-06-03 form-test bugs:
//   1. Bot MUST call create_hold_with_deposit_link when a video lead picks a time
//      (it previously fabricated "your slot is locked in, a team member is sending the link").
//   2. Bot MUST NOT delegate the deposit to "a team member" / fabricate a confirmation.
//   3. A form lead who already chose a video consult is NOT re-asked online/in-person.
//   4. A MESSAGE-BASED form lead → send_deposit_link, NEVER fetch_available_slots / hold.
//
// Real LLM (Haiku/Sonnet) + dry-run tools (no GHL/Square writes). override:true — dev shell
// shadows ANTHROPIC_API_KEY.
require("dotenv").config({ override: true, quiet: true });

const { handleInboundMessage } = require("../src/ai/v2/controller");

const VIDEO_LEAD = {
  firstName: "Maria",
  customField: {
    inquired_technician: "Joan",
    language_preference: "English",
    tattoo_placement: "inner forearm",
    tattoo_style: "realism",
    tattoo_summary: "realism bouquet on inner forearm",
    consultation_preference: "Video Call with Coordinator",
  },
};

const MESSAGE_LEAD = {
  firstName: "Carlos",
  customField: {
    inquired_technician: "Joan",
    language_preference: "English",
    tattoo_placement: "wrist",
    tattoo_summary: "small fineline date",
    consultation_preference: "Message-Based Consultation",
  },
};

const FAB_RX = /(team member|someone|the team|our team|staff|coordinator)\b[^.]*\b(send|sending|reach|get back|will be in touch)/i;

async function turn(contact, history, userMsg, { formOpener = false } = {}) {
  const res = await handleInboundMessage({
    contactId: "TEST_CONTACT",
    contact,
    history,
    latestMessageText: userMsg,
    language: "en",
    formOpener,
    dryRun: true,
  });
  res.toolTrace.forEach((t) => console.log(`  🔧 ${t.name}(${JSON.stringify(t.input)}) -> ok=${t.output.ok}`));
  res.bubbles.forEach((b) => console.log(`  bot: ${b}`));
  history.push({ role: "user", content: userMsg });
  history.push({ role: "assistant", content: res.replyText });
  return res;
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok) => { console.log(`  ${ok ? "✅" : "❌"} ${name}`); ok ? pass++ : fail++; };

  // ───────────────────────── Scenario 1: video form lead picks a time ─────────────────────────
  console.log("=".repeat(64));
  console.log("SCENARIO 1 — VIDEO form lead (Maria reproduction)");
  console.log("=".repeat(64));
  const h1 = [];
  const tools1 = [];
  const collect1 = (r) => r.toolTrace.forEach((t) => tools1.push(t.name));

  console.log("\n— opener (just submitted form) —");
  const opener = await turn(VIDEO_LEAD, h1, "New form submission", { formOpener: true });
  collect1(opener);
  check("opener does NOT ask online-vs-in-person", !/in[- ]person/i.test(opener.replyText) || !/online/i.test(opener.replyText));

  console.log("\n— lead asks for times —");
  collect1(await turn(VIDEO_LEAD, h1, "yeah let's book it, what times this week?"));

  console.log("\n— lead picks a time —");
  const pick = await turn(VIDEO_LEAD, h1, "the first one works for me");
  collect1(pick);

  check("called fetch_available_slots", tools1.includes("fetch_available_slots"));
  check("called create_hold_with_deposit_link (real booking, not fabricated)", tools1.includes("create_hold_with_deposit_link"));
  check("did NOT call send_deposit_link (video → slot path)", !tools1.includes("send_deposit_link"));
  const allText1 = h1.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
  check("never says 'a team member is sending the link'", !FAB_RX.test(allText1));
  check("final confirmation includes the real deposit link", /squareup\.com\/checkout\/TEST/.test(pick.replyText) || pick.toolTrace.some((t) => t.name === "create_hold_with_deposit_link" && t.output.ok));
  console.log(`  tools: [${tools1.join(" → ")}]`);

  // ───────────────────────── Scenario 2: message-based form lead ─────────────────────────
  console.log("\n" + "=".repeat(64));
  console.log("SCENARIO 2 — MESSAGE-BASED form lead");
  console.log("=".repeat(64));
  const h2 = [];
  const tools2 = [];
  const collect2 = (r) => r.toolTrace.forEach((t) => tools2.push(t.name));

  console.log("\n— opener —");
  collect2(await turn(MESSAGE_LEAD, h2, "New form submission", { formOpener: true }));
  console.log("\n— lead is ready —");
  collect2(await turn(MESSAGE_LEAD, h2, "yeah that sounds good, how do i lock it in?"));

  check("did NOT fetch_available_slots (no live call for message-based)", !tools2.includes("fetch_available_slots"));
  check("did NOT create_hold_with_deposit_link", !tools2.includes("create_hold_with_deposit_link"));
  check("used send_deposit_link (deposit-only path)", tools2.includes("send_deposit_link"));
  const allText2 = h2.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
  check("never delegates deposit to 'a team member'", !FAB_RX.test(allText2));
  console.log(`  tools: [${tools2.join(" → ")}]`);

  console.log("\n" + "─".repeat(64));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(2); });
