#!/usr/bin/env node
// test-v2-tools.js — Phase 2 tool-use verification.
//
// Part A (dry-run): drive a full booking conversation with MOCKED tool handlers and verify
//   the LLM selects the right tools, in the right order, with valid args. ZERO side effects
//   (no real holds, no real deposit links).
// Part B (read-only live): call the real fetch_available_slots handler against the live GHL
//   calendars. Read-only — creates nothing.
//
// override:true is required locally (dev shell shadows ANTHROPIC_API_KEY).
require("dotenv").config({ override: true, quiet: true });

const { handleInboundMessage } = require("../src/ai/v2/controller");
const { executeTool } = require("../src/ai/v2/tools");

// Drive one user turn through the bot; append the exchange to history. dry-run.
async function turn(history, userMsg, label) {
  const res = await handleInboundMessage({
    contactId: "TEST_CONTACT",
    history,
    latestMessageText: userMsg,
    dryRun: true,
  });
  console.log(`\n— ${label} —`);
  console.log(`lead: ${userMsg}`);
  res.toolTrace.forEach((t) => console.log(`  🔧 ${t.name}(${JSON.stringify(t.input)}) -> ok=${t.output.ok}`));
  res.bubbles.forEach((b) => console.log(`bot: ${b}`));
  history.push({ role: "user", content: userMsg });
  history.push({ role: "assistant", content: res.replyText });
  return res;
}

(async () => {
  console.log("=".repeat(64));
  console.log("PART A — dry-run booking flow (mocked tools, no side effects)");
  console.log("=".repeat(64));

  const history = [];
  const allTools = [];
  const collect = (res) => res.toolTrace.forEach((t) => allTools.push(t.name));

  collect(await turn(history, "hey i want to book a consult for a forearm piece, my first tattoo", "intake"));
  collect(await turn(history, "let's do video", "consult type"));
  collect(await turn(history, "what times do you have?", "ask availability"));
  // Pick whatever the bot offered — reference the first slot generically.
  collect(await turn(history, "the first one works for me", "pick slot"));
  collect(await turn(history, "ok cool, thanks!", "post-hold"));

  // ── assertions on tool selection/order ──
  console.log("\n──────── ASSERTIONS ────────");
  const idxFetch = allTools.indexOf("fetch_available_slots");
  const idxHold = allTools.indexOf("create_hold_with_deposit_link");
  const checks = [
    ["called fetch_available_slots", idxFetch !== -1],
    ["called create_hold_with_deposit_link", idxHold !== -1],
    ["fetched slots BEFORE creating hold", idxFetch !== -1 && idxHold !== -1 && idxFetch < idxHold],
    ["saved lead fields (update_lead_fields)", allTools.includes("update_lead_fields")],
    ["did NOT invent a hold before fetching", !(idxHold !== -1 && (idxFetch === -1 || idxHold < idxFetch))],
  ];
  let pass = 0;
  checks.forEach(([name, ok]) => { console.log(`  ${ok ? "✅" : "❌"} ${name}`); if (ok) pass++; });
  console.log(`  tools used in order: [${allTools.join(" → ")}]`);

  // ── mini-scenarios: cancel + field update ──
  console.log("\n— cancel scenario —");
  const cancel = await handleInboundMessage({
    contactId: "TEST_CONTACT",
    contact: { customField: { hold_appointment_id: "HOLD_TEST_123" } },
    history: [
      { role: "user", content: "i booked a consult for friday" },
      { role: "assistant", content: "yep you're holding friday 3pm — want me to keep it?" },
    ],
    latestMessageText: "actually i need to cancel that",
    dryRun: true,
  });
  cancel.toolTrace.forEach((t) => console.log(`  🔧 ${t.name} -> ok=${t.output.ok}`));
  cancel.bubbles.forEach((b) => console.log(`bot: ${b}`));
  const cancelOk = cancel.toolTrace.some((t) => t.name === "cancel_appointment");
  console.log(`  ${cancelOk ? "✅" : "❌"} called cancel_appointment`);

  console.log("\n" + "=".repeat(64));
  console.log("PART B — read-only LIVE fetch_available_slots (real calendars, creates nothing)");
  console.log("=".repeat(64));
  try {
    const live = await executeTool(
      "fetch_available_slots",
      { consult_type: "online", artist: "any" },
      { contactId: "READONLY_TEST", language: "en", dryRun: false }
    );
    console.log(`live fetch ok=${live.ok} count=${live.count ?? 0}`);
    if (live.slots && live.slots.length) {
      console.log("first 3 real slots:");
      live.slots.slice(0, 3).forEach((s) => console.log(`  • ${s.display} (${s.artist})`));
    } else if (live.error) {
      console.log("note:", live.error);
    }
  } catch (e) {
    console.log("live fetch threw:", e.message);
  }

  console.log("\n" + "=".repeat(64));
  console.log(`PART A core checks: ${pass}/${checks.length} passed`);
  console.log("=".repeat(64) + "\n");
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
