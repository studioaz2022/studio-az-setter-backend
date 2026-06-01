#!/usr/bin/env node
// test-classifier-fixtures.js — accuracy harness for the v2 funnel classifier (Phase 0.5)
//
// Runs the gpt-4.1-mini classifier against a labeled fixture set and reports accuracy.
// Primary metric: is_tattoo_lead correctness (the gate decision that matters).
// Secondary: confidence falls within an acceptable band, and language matches.
//
// Goal: tune classifier_prompt.md until is_tattoo_lead accuracy is >95%.
//
// Usage: node scripts/test-classifier-fixtures.js [--verbose]

require("dotenv").config({ quiet: true });
const { classifyLead } = require("../src/ai/v2/classifier");

const VERBOSE = process.argv.includes("--verbose");

// Each fixture:
//   name, input ({messages?, formData?})
//   expectLead (boolean) — the decision that must be right
//   okConfidence (array) — acceptable confidence levels (soft check)
//   expectLang (optional) — expected language
const FIXTURES = [
  // ───────── Clear tattoo leads (EN) ─────────
  { name: "price-forearm", input: { messages: ["how much for a small forearm tattoo?"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },
  { name: "booking-sleeve", input: { messages: ["hey i want to book a half sleeve, do you have anything in march?"] }, expectLead: true, okConfidence: ["high"], expectLang: "en" },
  { name: "fineline-idea", input: { messages: ["looking for a small fineline rose on my wrist, first tattoo"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },
  { name: "consult-question", input: { messages: ["do i need a consultation before getting tattooed?"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },
  { name: "deposit-question", input: { messages: ["is the deposit refundable if i change my mind on the design?"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },
  { name: "coverup", input: { messages: ["can you guys do a cover up of an old tattoo on my shoulder?"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },
  { name: "walkins", input: { messages: ["do you do walk ins or is it appointment only"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },
  { name: "artist-style", input: { messages: ["who does black and grey realism at your shop?"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },
  { name: "touchup-prev", input: { messages: ["i got tattooed by andrew last year, need a touch up"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },
  { name: "how-much-tattoo", input: { messages: ["how much for a tattoo?"] }, expectLead: true, okConfidence: ["high", "medium", "low"], expectLang: "en" },

  // ───────── Clear tattoo leads (ES) ─────────
  { name: "es-arm-price", input: { messages: ["hola, quiero un tatuaje en el brazo, cuanto cuesta?"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "es" },
  { name: "es-cita", input: { messages: ["buenas, quisiera agendar una cita para un tatuaje pequeño"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "es" },
  { name: "es-deposito", input: { messages: ["el deposito es reembolsable? estoy pensando en un tatuaje"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "es" },
  { name: "es-idea", input: { messages: ["tengo una idea para un tatuaje en la pierna, una flor con nombre"] }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "es" },

  // ───────── Form-driven leads (no message) ─────────
  { name: "form-only", input: { formData: { placement: "forearm", size: "medium", style: "fineline", timeline: "within a month", first_tattoo: "yes", language: "en" } }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },
  { name: "form-es", input: { formData: { placement: "brazo", style: "realismo", timeline: "1-3 months", language: "es" } }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "es" },
  { name: "form-plus-msg", input: { messages: ["hi! just filled out the form"], formData: { placement: "back", style: "japanese", timeline: "ASAP" } }, expectLead: true, okConfidence: ["high", "medium"], expectLang: "en" },

  // ───────── Ambiguous but plausible (should lean lead, any confidence) ─────────
  { name: "vague-info", input: { messages: ["hey can i get some info?"] }, expectLead: true, okConfidence: ["medium", "low"], expectLang: "en" },
  { name: "you-open", input: { messages: ["are you guys open today?"] }, expectLead: true, okConfidence: ["medium", "low"], expectLang: "en" },
  { name: "prices-generic", input: { messages: ["what are your prices like?"] }, expectLead: true, okConfidence: ["medium", "low"], expectLang: "en" },
  { name: "appointment-generic", input: { messages: ["i'd like to make an appointment"] }, expectLead: true, okConfidence: ["high", "medium", "low"], expectLang: "en" },

  // ───────── Clear NON-leads ─────────
  { name: "seo-spam", input: { messages: ["Hi, I can get your business ranking #1 on Google. Interested in SEO?"] }, expectLead: false, okConfidence: ["low"], expectLang: "en" },
  { name: "marketing-spam", input: { messages: ["Boost your sales with our AI marketing platform — free demo!"] }, expectLead: false, okConfidence: ["low"], expectLang: "en" },
  { name: "recruiter", input: { messages: ["We have a great job opportunity for experienced sales reps."] }, expectLead: false, okConfidence: ["low"], expectLang: "en" },
  { name: "wrong-number", input: { messages: ["Hey mom, can you pick me up at 5?"] }, expectLead: false, okConfidence: ["low"], expectLang: "en" },
  { name: "barbershop", input: { messages: ["do you have any openings for a haircut and beard trim today?"] }, expectLead: false, okConfidence: ["low"], expectLang: "en" },
  { name: "barbershop-es", input: { messages: ["a que hora puedo ir por un corte de cabello?"] }, expectLead: false, okConfidence: ["low"], expectLang: "es" },
  { name: "vendor", input: { messages: ["This is Sysco — your supply invoice #4821 is past due."] }, expectLead: false, okConfidence: ["low"], expectLang: "en" },
  { name: "crypto-spam", input: { messages: ["Congratulations! You've won 2 BTC. Click here to claim."] }, expectLead: false, okConfidence: ["low"], expectLang: "en" },
  { name: "bare-hi", input: { messages: ["hi"] }, expectLead: false, okConfidence: ["low", "medium"], expectLang: "en" },

  // ───────── Tricky: tattoo word but not a lead ─────────
  { name: "removal", input: { messages: ["do you do tattoo removal? i want this gone"] }, expectLead: false, okConfidence: ["low", "medium"], expectLang: "en" },
  { name: "supplier", input: { messages: ["We supply tattoo ink and needles wholesale — want our catalog?"] }, expectLead: false, okConfidence: ["low"], expectLang: "en" },
];

(async () => {
  console.log(`\n🧪 Classifier fixtures — ${FIXTURES.length} cases against gpt-4.1-mini\n`);
  let leadCorrect = 0;
  let confOk = 0;
  let langOk = 0;
  const failures = [];

  // Run with light concurrency to keep it quick but avoid rate spikes.
  const results = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < FIXTURES.length; i += CONCURRENCY) {
    const batch = FIXTURES.slice(i, i + CONCURRENCY);
    const batchRes = await Promise.all(
      batch.map(async (fx) => ({ fx, res: await classifyLead(fx.input) }))
    );
    results.push(...batchRes);
  }

  for (const { fx, res } of results) {
    const leadOk = res.is_tattoo_lead === fx.expectLead;
    const cOk = !fx.okConfidence || fx.okConfidence.includes(res.confidence);
    const lOk = !fx.expectLang || res.language === fx.expectLang;
    if (leadOk) leadCorrect++;
    if (cOk) confOk++;
    if (lOk) langOk++;

    const mark = leadOk ? "✅" : "❌";
    if (!leadOk || !cOk || !lOk || VERBOSE) {
      console.log(
        `${mark} ${fx.name.padEnd(22)} lead=${res.is_tattoo_lead} (exp ${fx.expectLead}) ` +
          `conf=${res.confidence}${cOk ? "" : " ⚠"} lang=${res.language}${lOk ? "" : " ⚠"}` +
          (VERBOSE ? `\n     ↳ ${res.reasoning}` : "")
      );
    }
    if (!leadOk) failures.push({ name: fx.name, got: res, exp: fx.expectLead });
  }

  const n = FIXTURES.length;
  const pct = (x) => ((x / n) * 100).toFixed(1);
  console.log("\n──────── RESULTS ────────");
  console.log(`is_tattoo_lead accuracy : ${leadCorrect}/${n}  (${pct(leadCorrect)}%)   [target >95%]`);
  console.log(`confidence in band      : ${confOk}/${n}  (${pct(confOk)}%)`);
  console.log(`language match          : ${langOk}/${n}  (${pct(langOk)}%)`);
  if (failures.length) {
    console.log(`\n❌ Lead-decision misses (${failures.length}):`);
    failures.forEach((f) => console.log(`   - ${f.name}: got ${f.got.is_tattoo_lead} "${f.got.reasoning}"`));
  }
  const passed = leadCorrect / n > 0.95;
  console.log(`\n${passed ? "✅ PASS" : "❌ BELOW TARGET"} — lead accuracy ${pct(leadCorrect)}%\n`);
  process.exit(passed ? 0 : 1);
})();
