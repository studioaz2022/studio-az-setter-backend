#!/usr/bin/env node
// One-off sandbox smoke test for refundPayment() — Phase 1 STOP & VERIFY.
//
// Creates a $1.00 sandbox payment with the standard test nonce, then refunds it
// via the new helper. Asserts the helper returns PENDING or COMPLETED, the
// refund id differs from the payment id, and the token-generator is unique.
//
// Run from backend root:
//   node scripts/refund-smoketest.js
//
// Requires sandbox SQUARE_ACCESS_TOKEN + SQUARE_ENVIRONMENT=sandbox in .env.

require("dotenv").config();

const axios = require("axios");
const { refundPayment } = require("../src/payments/squareClient");
const { generateRefundToken } = require("../src/refundRequest/refundRequestService");

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SQUARE_ENVIRONMENT = process.env.SQUARE_ENVIRONMENT || "sandbox";
const SQUARE_BASE_URL =
  SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

if (SQUARE_ENVIRONMENT !== "sandbox") {
  console.error("❌ Refusing to run — SQUARE_ENVIRONMENT is not 'sandbox'.");
  process.exit(2);
}

async function createTestPayment() {
  const body = {
    idempotency_key: `smoketest-${Date.now()}`,
    source_id: "cnon:card-nonce-ok", // sandbox test nonce → COMPLETED
    amount_money: { amount: 100, currency: "USD" }, // $1.00
    location_id: SQUARE_LOCATION_ID,
    autocomplete: true,
  };
  const res = await axios.post(`${SQUARE_BASE_URL}/v2/payments`, body, {
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  return res.data.payment;
}

async function main() {
  const results = [];

  // 1. Token generator — uniqueness + length.
  const tokens = new Set();
  for (let i = 0; i < 1000; i++) tokens.add(generateRefundToken());
  const t = generateRefundToken();
  results.push({
    check: "generateRefundToken: 48-char hex",
    pass: /^[0-9a-f]{48}$/.test(t),
    detail: t,
  });
  results.push({
    check: "generateRefundToken: 1000 unique",
    pass: tokens.size === 1000,
    detail: `${tokens.size}/1000 unique`,
  });

  // 2. Create the sandbox payment to refund.
  console.log("→ Creating sandbox $1.00 payment...");
  const payment = await createTestPayment();
  console.log(`  payment.id=${payment.id} status=${payment.status}`);
  results.push({
    check: "test payment COMPLETED",
    pass: payment.status === "COMPLETED",
    detail: payment.status,
  });

  // 3. Refund via the new helper.
  const idempotencyKey = generateRefundToken(); // 48 chars; helper truncates to 45
  console.log(`→ Refunding via refundPayment() with idempotencyKey=${idempotencyKey} (48 chars)...`);
  const refund = await refundPayment({
    paymentId: payment.id,
    amountCents: 100,
    idempotencyKey,
    reason: "Phase 1 smoketest — automated",
  });
  console.log("  refund:", refund);

  results.push({
    check: "refundPayment returns refundId",
    pass: typeof refund.refundId === "string" && refund.refundId.length > 0,
    detail: refund.refundId,
  });
  results.push({
    check: "refundId is distinct from paymentId",
    pass: refund.refundId !== payment.id,
    detail: `payment=${payment.id} refund=${refund.refundId}`,
  });
  results.push({
    check: "refund status ∈ {PENDING, COMPLETED}",
    pass: refund.status === "PENDING" || refund.status === "COMPLETED",
    detail: refund.status,
  });
  results.push({
    check: "refund amountCents echoed",
    pass: refund.amountCents === 100,
    detail: String(refund.amountCents),
  });

  // 4. Idempotency: replay the same key → Square returns the same refund.
  console.log("→ Replaying the same idempotency key (must return the same refund)...");
  const replay = await refundPayment({
    paymentId: payment.id,
    amountCents: 100,
    idempotencyKey,
    reason: "Phase 1 smoketest — replay",
  });
  results.push({
    check: "idempotency: replay returns same refundId",
    pass: replay.refundId === refund.refundId,
    detail: `original=${refund.refundId} replay=${replay.refundId}`,
  });

  // Report.
  console.log("\n=== RESULTS ===");
  let failed = 0;
  for (const r of results) {
    const mark = r.pass ? "✅" : "❌";
    console.log(`${mark} ${r.check} — ${r.detail}`);
    if (!r.pass) failed++;
  }
  if (failed === 0) {
    console.log("\n🎉 Phase 1 STOP & VERIFY: PASS");
    process.exit(0);
  } else {
    console.log(`\n❌ Phase 1 STOP & VERIFY: ${failed} check(s) FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n❌ Smoke test crashed:", err.message);
  if (err.response) {
    console.error("  HTTP", err.response.status, JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
