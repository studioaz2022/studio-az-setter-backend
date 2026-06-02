#!/usr/bin/env node
// objection-tuning-review.js — Phase 6 recurring objection tuning checkpoint.
//
// Pulls the objection_events log and produces the review the plan calls for:
//   - which objections fired, how often
//   - which model handled them (haiku vs sonnet escalation)
//   - outcome breakdown (deposit_paid / went_cold / human_took_over / pending)
//   - flagged tuning candidates: objections whose replies may be falling flat
//
// This is the tool; the actual review is a recurring human checkpoint (monthly for the first
// 3-6 months). Run after v2 has ≥2 weeks of real traffic. Until the objection_events table
// exists and has rows, it reports "no data yet — checkpoint not due" and exits cleanly.
//
// Usage: node scripts/objection-tuning-review.js [--days 30] [--support N]   (--support: an
//        injected JSON file of synthetic rows for offline testing; see --self-test)
require("dotenv").config({ override: true, quiet: true });
const { supabase } = require("../src/clients/supabaseClient");

const args = process.argv.slice(2);
const DAYS = parseInt((args[args.indexOf("--days") + 1] || "30"), 10) || 30;
const SELF_TEST = args.includes("--self-test");

// Synthetic rows for offline verification of the report logic (no DB needed).
const SELF_TEST_ROWS = [
  { objection_id: "price_too_high", model_used: "claude-sonnet-4-6", outcome: "deposit_paid" },
  { objection_id: "price_too_high", model_used: "claude-sonnet-4-6", outcome: "went_cold" },
  { objection_id: "price_too_high", model_used: "claude-haiku-4-5-20251001", outcome: "went_cold" },
  { objection_id: "need_to_think", model_used: "claude-sonnet-4-6", outcome: "went_cold" },
  { objection_id: "need_to_think", model_used: "claude-sonnet-4-6", outcome: "went_cold" },
  { objection_id: "need_to_think", model_used: "claude-sonnet-4-6", outcome: "went_cold" },
  { objection_id: "refund_skepticism", model_used: "claude-sonnet-4-6", outcome: "deposit_paid" },
  { objection_id: "refund_skepticism", model_used: "claude-sonnet-4-6", outcome: "deposit_paid" },
  { objection_id: "fear_first_tattoo", model_used: "claude-sonnet-4-6", outcome: null },
];

const ALL_OBJECTIONS = [
  "price_too_high", "need_to_think", "ask_partner", "fear_first_tattoo", "timing_not_ready",
  "design_uncertain", "refund_skepticism", "talk_to_artist", "exact_price_now", "reschedule_anxiety",
];

function analyze(rows) {
  const byId = {};
  for (const r of rows) {
    const id = r.objection_id || "(none)";
    byId[id] = byId[id] || { total: 0, sonnet: 0, haiku: 0, deposit_paid: 0, went_cold: 0, human_took_over: 0, pending: 0 };
    const b = byId[id];
    b.total++;
    if ((r.model_used || "").includes("sonnet")) b.sonnet++; else b.haiku++;
    if (r.outcome === "deposit_paid") b.deposit_paid++;
    else if (r.outcome === "went_cold") b.went_cold++;
    else if (r.outcome === "human_took_over") b.human_took_over++;
    else b.pending++;
  }
  return byId;
}

function report(rows) {
  console.log(`\n📊 OBJECTION TUNING REVIEW — ${rows.length} events (last ${DAYS}d)\n` + "=".repeat(60));
  const byId = analyze(rows);

  const ranked = Object.entries(byId).sort((a, b) => b[1].total - a[1].total);
  console.log("\nobjection            total  sonnet  paid  cold  human  pend   cold%");
  console.log("-".repeat(70));
  for (const [id, b] of ranked) {
    const decided = b.deposit_paid + b.went_cold + b.human_took_over;
    const coldPct = decided ? Math.round((b.went_cold / decided) * 100) : 0;
    console.log(
      `${id.padEnd(20)} ${String(b.total).padStart(5)}  ${String(b.sonnet).padStart(6)}  ` +
      `${String(b.deposit_paid).padStart(4)}  ${String(b.went_cold).padStart(4)}  ${String(b.human_took_over).padStart(5)}  ` +
      `${String(b.pending).padStart(4)}  ${String(coldPct).padStart(4)}%`
    );
  }

  // Tuning candidates.
  console.log("\n🔧 TUNING CANDIDATES");
  const flags = [];
  for (const [id, b] of ranked) {
    const decided = b.deposit_paid + b.went_cold + b.human_took_over;
    const coldPct = decided ? b.went_cold / decided : 0;
    if (decided >= 3 && coldPct >= 0.6) flags.push(`• ${id}: ${Math.round(coldPct * 100)}% went cold (${b.went_cold}/${decided}) — reply may feel canned or the reframe isn't landing. Review wording.`);
  }
  const neverFired = ALL_OBJECTIONS.filter((id) => !byId[id]);
  if (neverFired.length) flags.push(`• never detected: ${neverFired.join(", ")} — either rare, or detection patterns are missing real phrasings.`);
  if (!flags.length) console.log("  (none — nothing crossed the tuning thresholds)");
  else flags.forEach((f) => console.log("  " + f));

  console.log("\nNext: for flagged objections, read the raw rows (message_text + bot_reply) and");
  console.log("soften example responses in src/prompts/v4/objection_principles.md. This is recurring.\n");
}

(async () => {
  if (SELF_TEST) {
    console.log("(--self-test: running report on synthetic rows, no DB)");
    report(SELF_TEST_ROWS);
    return;
  }
  if (!supabase) {
    console.log("ℹ️ Supabase not configured — cannot run review.");
    return;
  }
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  const { data, error } = await supabase
    .from("objection_events")
    .select("objection_id, model_used, outcome, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error) {
    console.log(`ℹ️ No data yet — checkpoint not due. (${error.message})`);
    console.log("   The objection_events table must be applied AND v2 must have ~2 weeks of real traffic.");
    return;
  }
  if (!data || !data.length) {
    console.log("ℹ️ objection_events is empty — checkpoint not due (no objections logged yet).");
    return;
  }
  report(data);
})().catch((e) => { console.error("review error:", e.message); process.exit(1); });
