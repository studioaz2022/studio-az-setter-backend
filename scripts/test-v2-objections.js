#!/usr/bin/env node
// test-v2-objections.js — Phase 3 objection handling + escalation verification.
//
// For each objection scenario:
//   - verify the escalation layer detects it and routes to Sonnet
//   - print the reply for voice review (validate-first, one reframe, soft-close rule)
//   - check the reply doesn't open with "but"/"actually"
// Plus a Haiku-vs-Sonnet side-by-side on a couple scenarios to judge whether escalation earns
// its cost.
//
// override:true — dev shell shadows ANTHROPIC_API_KEY.
require("dotenv").config({ override: true, quiet: true });

const { handleInboundMessage } = require("../src/ai/v2/controller");
const { MODELS } = require("../src/ai/v2/anthropicClient");

// history that establishes the deposit was explained. Some scenarios put a time on the table.
const depositExplained = [
  { role: "user", content: "how do i get started?" },
  { role: "assistant", content: "we lock in your spot with a $100 deposit — fully refundable if you don't love the design, and it goes toward your tattoo. want me to find a couple consult times?" },
];
const timeOnTable = [
  ...depositExplained,
  { role: "user", content: "ok what do you have thursday" },
  { role: "assistant", content: "i've got thursday at 2pm or 4pm with andrew — which works?" },
];

const SCENARIOS = [
  { name: "price_too_high (no time)", expectId: "price_too_high", history: depositExplained, msg: "honestly $100 just to talk seems like a lot" },
  { name: "need_to_think (no time)", expectId: "need_to_think", history: depositExplained, msg: "i think i need to think about it for a bit" },
  { name: "ask_partner (no time)", expectId: "ask_partner", history: depositExplained, msg: "i should probably ask my wife first" },
  { name: "fear_first_tattoo (no time)", expectId: "fear_first_tattoo", history: depositExplained, msg: "this would be my first tattoo and i'm kinda nervous it'll hurt" },
  { name: "refund_skepticism (time on table)", expectId: "refund_skepticism", history: timeOnTable, msg: "wait is it actually refundable or is that just a line" },
  { name: "exact_price_now (no time)", expectId: "exact_price_now", history: depositExplained, msg: "can you just tell me how much it'll cost first" },
  { name: "reschedule_anxiety (time on table)", expectId: "reschedule_anxiety", history: timeOnTable, msg: "what if something comes up and i can't make it" },
];

function startsBadly(t) {
  return /^\s*(but|actually)\b/i.test(t);
}

(async () => {
  console.log("=".repeat(66));
  console.log("OBJECTION HANDLING + ESCALATION");
  console.log("=".repeat(66));

  let escOk = 0, idOk = 0, openOk = 0;
  for (const sc of SCENARIOS) {
    const res = await handleInboundMessage({
      contactId: "TEST_OBJ",
      history: sc.history,
      latestMessageText: sc.msg,
      dryRun: true,
    });
    const e = res.escalation;
    const escalated = e.escalate && res.model === MODELS.SONNET;
    const idMatch = e.objectionId === sc.expectId;
    const openClean = !startsBadly(res.replyText);
    if (escalated) escOk++;
    if (idMatch) idOk++;
    if (openClean) openOk++;

    console.log(`\n### ${sc.name}`);
    console.log(`lead: ${sc.msg}`);
    console.log(`  escalation: ${e.reason || "none"} | model=${res.model.includes("sonnet") ? "SONNET" : "haiku"} ${escalated ? "✅" : "❌"} | id=${e.objectionId || "—"} ${idMatch ? "✅" : "⚠(expected " + sc.expectId + ")"}`);
    res.bubbles.forEach((b) => console.log(`bot: ${b}`));
    if (!openClean) console.log("  ⚠ opens with but/actually");
  }

  console.log("\n" + "=".repeat(66));
  console.log("HAIKU vs SONNET — same objection, judge if escalation earns its cost");
  console.log("=".repeat(66));
  const compareMsg = "honestly $100 just to talk seems steep, and i'm not even sure on the design yet";
  for (const m of [MODELS.HAIKU, MODELS.SONNET]) {
    const res = await handleInboundMessage({
      contactId: "TEST_CMP", history: depositExplained, latestMessageText: compareMsg, dryRun: true, forceModel: m,
    });
    console.log(`\n— ${m.includes("sonnet") ? "SONNET 4.6" : "HAIKU 4.5"} —`);
    res.bubbles.forEach((b) => console.log(b));
  }

  console.log("\n" + "=".repeat(66));
  console.log(`escalated→Sonnet: ${escOk}/${SCENARIOS.length} | objection id correct: ${idOk}/${SCENARIOS.length} | clean opener: ${openOk}/${SCENARIOS.length}`);
  console.log("=".repeat(66) + "\n");
  process.exit(escOk === SCENARIOS.length ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
