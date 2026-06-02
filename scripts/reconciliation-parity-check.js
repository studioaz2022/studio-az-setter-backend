#!/usr/bin/env node
// Phase 2 STOP & VERIFY parity check.
//
// Plan §6.7 gotcha #2: payment-history (iOS ledger) and financial-summary
// (rent-tracker tiles + mark-complete) historically disagreed on `collected`
// when a refund existed — payment-history subtracted, financial-summary
// over-counted. Phase 2 patches computeContactReconciliation. This script
// proves the two now produce the same number on a seeded scenario, exactly
// the way the plan asks ("seed a contact with a deposit + a refund row in a
// scratch test; confirm financial-summary and payment-history now report the
// same collected/outstanding").
//
// Runs in-process — no DB, no network. Compares two pure-functional
// implementations against synthetic rows that match the production schema.

const {
  computeContactReconciliation,
} = require("../src/services/reconciliationService");

// Inline copy of the math payment-history applies — purposely lifted from
// app.js:2348-2402 so we're comparing the engine to the canonical iOS path.
function paymentHistoryCollected(transactions) {
  let collected = 0;
  for (const tx of transactions) {
    const isRefund =
      (tx.transaction_type || "").toLowerCase().includes("refund") ||
      (tx.gross_amount || 0) < 0;
    const gross = Math.abs(tx.gross_amount || 0);
    const tip = tx.tip_amount || 0;
    const servicePortion = tip > 0 ? gross - tip : gross;
    // Stripe financing fee parsing omitted — Square refunds don't carry it.
    const collectedAmount = servicePortion;
    if (servicePortion > 0) {
      collected += isRefund ? -collectedAmount : collectedAmount;
    }
  }
  return Math.round(collected * 100) / 100;
}

function row({ gross, recipient = "shop", type = "session_payment", method = "square" }) {
  // Match the live `transactions` schema. shop/artist split at the prod
  // 30/70 rate the deposit webhook uses.
  const shopPct = 30;
  const absGross = Math.abs(gross);
  const shopAmt = Math.round(absGross * shopPct) / 100;
  const artistAmt = absGross - shopAmt;
  return {
    transaction_type: type,
    payment_method: method,
    payment_recipient: recipient,
    gross_amount: gross,
    shop_percentage: shopPct,
    artist_percentage: 100 - shopPct,
    shop_amount: shopAmt,
    artist_amount: artistAmt,
    tip_amount: 0,
  };
}

const scenarios = [
  {
    name: "deposit only (no refund yet)",
    quote: 1000,
    transactions: [row({ gross: 100, type: "deposit" })],
    expectedCollected: 100,
  },
  {
    name: "deposit + production-shape refund (positive gross, type=refund)",
    quote: 1000,
    transactions: [
      row({ gross: 100, type: "deposit" }),
      row({ gross: 100, type: "refund" }),
    ],
    expectedCollected: 0,
  },
  {
    name: "deposit + partial refund",
    quote: 1000,
    transactions: [
      row({ gross: 500, type: "session_payment" }),
      row({ gross: 200, type: "refund" }),
    ],
    expectedCollected: 300,
  },
  {
    name: "deposit + legacy-shape refund (negative gross, no type)",
    quote: 1000,
    transactions: [
      row({ gross: 100, type: "deposit" }),
      row({ gross: -100, type: "session_payment" }),
    ],
    expectedCollected: 0,
  },
  {
    name: "no refund — sanity check (engine unaffected)",
    quote: 1000,
    transactions: [
      row({ gross: 100, type: "deposit" }),
      row({ gross: 900, type: "session_payment" }),
    ],
    expectedCollected: 1000,
  },
];

const results = [];
for (const s of scenarios) {
  const engine = computeContactReconciliation({
    quote: s.quote,
    shopPercentage: 30,
    transactions: s.transactions,
  });
  const ph = paymentHistoryCollected(s.transactions);
  const engineCollected = engine.collected;

  const enginePass = engineCollected === s.expectedCollected;
  const phPass = ph === s.expectedCollected;
  const agree = engineCollected === ph;

  results.push({
    name: s.name,
    expected: s.expectedCollected,
    engine: engineCollected,
    paymentHistory: ph,
    engineMatches: enginePass,
    paymentHistoryMatches: phPass,
    agree,
  });
}

console.log("=== Phase 2 parity check ===\n");
let failed = 0;
for (const r of results) {
  const mark =
    r.engineMatches && r.paymentHistoryMatches && r.agree ? "✅" : "❌";
  console.log(
    `${mark} ${r.name}\n` +
      `   expected=${r.expected}  engine=${r.engine}  paymentHistory=${r.paymentHistory}  agree=${r.agree}`
  );
  if (!(r.engineMatches && r.paymentHistoryMatches && r.agree)) failed++;
}

if (failed === 0) {
  console.log("\n🎉 Phase 2 parity: PASS — engine and payment-history agree on every scenario.");
  process.exit(0);
} else {
  console.log(`\n❌ Phase 2 parity: ${failed} scenario(s) failed.`);
  process.exit(1);
}
