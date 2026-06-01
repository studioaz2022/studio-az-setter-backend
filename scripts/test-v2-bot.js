#!/usr/bin/env node
// test-v2-bot.js — Phase 1 voice check for the v2 conversational controller (talk-only).
//
// Runs a set of stubbed conversations through Haiku 4.5 + the 25-principle system prompt
// and prints each reply for manual review. A few soft automated checks flag obvious
// principle violations (language mirroring, inventing exact prices). This is a VOICE
// review tool, not a pass/fail gate — read the replies.
//
// NOTE: override:true is required locally — the dev shell exports an empty
// ANTHROPIC_API_KEY that shadows .env. Must run before requiring the controller.
require("dotenv").config({ override: true, quiet: true });

const { handleInboundMessage } = require("../src/ai/v2/controller");

const SCENARIOS = [
  {
    name: "New lead — EN, price question",
    input: { latestMessageText: "hey how much for a small forearm tattoo?" },
    expectLang: "en",
  },
  {
    name: "New lead — ES",
    input: { latestMessageText: "hola! quiero un tatuaje en el antebrazo, cuanto cuesta?" },
    expectLang: "es",
  },
  {
    name: "Vague opener",
    input: { latestMessageText: "hey can i get some info?" },
    expectLang: "en",
  },
  {
    name: "Ready to book",
    input: {
      history: [
        { role: "user", content: "i want a half sleeve, black and grey" },
        { role: "assistant", content: "love that. have you been tattooed before, or would this be your first?" },
        { role: "user", content: "got a couple already" },
      ],
      latestMessageText: "yeah let's set something up, when can i come in?",
    },
    expectLang: "en",
  },
  {
    name: "Objection — price too high",
    input: {
      history: [
        { role: "user", content: "how much to get started?" },
        { role: "assistant", content: "we lock in your spot with a $100 deposit — fully refundable if you don't love the design, and it goes toward your tattoo. want me to grab you a consult time?" },
      ],
      latestMessageText: "$100 just to talk? that seems steep honestly",
    },
    expectLang: "en",
  },
  {
    name: "Exact-price push (must not invent a number)",
    input: { latestMessageText: "just give me the exact price for a 4 inch rose on the wrist" },
    expectLang: "en",
  },
  {
    name: "Returning client",
    input: {
      contact: {
        firstName: "Marcus",
        customField: { returning_client: "true", total_tattoos_completed: "2", previous_conversation_summary: "got a forearm lion piece with Andrew last spring, loved it" },
      },
      latestMessageText: "yo it's marcus, thinking about getting another one",
    },
    expectLang: "en",
  },
  {
    name: "Post-deposit FAQ mode (calm, no selling)",
    input: { faqMode: true, latestMessageText: "hey what should i do to prep the day before my consult?" },
    expectLang: "en",
  },
];

// crude language sniff for the soft check
function looksSpanish(t) {
  return /\b(hola|gracias|tatuaje|cita|cuánto|cuanto|quieres|tienes|puedo|podemos|para|qué|cómo)\b/i.test(t) || /[¿¡ñáéíóú]/i.test(t);
}

(async () => {
  console.log("\n🤖 v2 bot voice check — Haiku 4.5, talk-only\n" + "=".repeat(60));
  let firstUsage = null;
  let lastUsage = null;

  for (const sc of SCENARIOS) {
    let res;
    try {
      res = await handleInboundMessage(sc.input);
    } catch (err) {
      console.log(`\n### ${sc.name}\n❌ ERROR: ${err.message}`);
      continue;
    }
    firstUsage = firstUsage || res.usage;
    lastUsage = res.usage;

    const lastUserMsg = sc.input.latestMessageText;
    console.log(`\n### ${sc.name}`);
    console.log(`lead: ${lastUserMsg}`);
    res.bubbles.forEach((b, i) => console.log(`bot${res.bubbles.length > 1 ? ` [${i + 1}]` : ""}: ${b}`));

    // soft checks
    const flags = [];
    const replyEs = looksSpanish(res.replyText);
    if (sc.expectLang === "es" && !replyEs) flags.push("⚠ expected Spanish reply");
    if (sc.expectLang === "en" && replyEs) flags.push("⚠ replied in Spanish to English lead");
    if (/\$\s?\d{2,}/.test(res.replyText) && !/\$\s?100\b|\$\s?50\b/.test(res.replyText)) {
      flags.push(`⚠ mentions a dollar amount other than the $100/$50 deposit: check for invented price`);
    }
    if (flags.length) console.log("  " + flags.join("  |  "));
    console.log(`  (${res.usage.input_tokens || "?"} in / ${res.usage.output_tokens || "?"} out, cache_read=${res.usage.cache_read_input_tokens ?? 0})`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`prompt caching: first-call cache_read=${firstUsage?.cache_read_input_tokens ?? 0}, last-call cache_read=${lastUsage?.cache_read_input_tokens ?? 0}`);
  console.log("(cache_read should jump above 0 after the first call — the system prompt is being reused)\n");
})();
