#!/usr/bin/env node
// Phase 3 STOP & VERIFY — exercises the refund-request lifecycle end-to-end
// against the live Supabase database, but WITHOUT touching GHL or Square.
//
// Why not call the full HTTP endpoint with a real contactId?
//   createRefundRequest fetches a real GHL contact and sends a real SMS via
//   GHL — both have side effects in production. The lifecycle behaviors we
//   need to prove (idempotent /send, prefill payload shape, double-submit
//   CAS, expired token, validation rejects) all live in the service layer
//   and use the DB as the source of truth. We seed `refund_requests` rows
//   directly via SQL and call the service functions on the inserted tokens.
//
// Cleanup: every row we create carries contact_id starting with "smoketest-"
// so we can wipe them in a single DELETE at the end.
//
// Run from backend root:
//   node scripts/refund-request-smoketest.js
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const {
  generateRefundToken,
  consultDidHappen,
  deriveDropOffStage,
  showConsultQualityFor,
  locatePaidDeposit,
  validateSubmission,
  mapDropOffToLastStage,
  mapReasonCodeToLostReason,
  getRefundRequestByToken,
  submitRefundRequest,
  DROP_OFF_STAGES,
} = require("../src/refundRequest/refundRequestService");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CONTACT_PREFIX = "smoketest-refundreq-";

let pass = 0;
let fail = 0;
function check(name, condition, detail = "") {
  const mark = condition ? "✅" : "❌";
  console.log(`${mark} ${name}${detail ? " — " + detail : ""}`);
  if (condition) pass++;
  else fail++;
}

async function seedRow({ contactId, token, dropOffStage, status, refundAmountCents, expiresAtIso, multiOrMissing = false }) {
  const { data, error } = await supabase
    .from("refund_requests")
    .insert({
      token,
      contact_id: contactId,
      drop_off_stage: dropOffStage,
      status: status || "pending",
      refund_amount_cents: refundAmountCents ?? 10000,
      currency: "USD",
      multi_or_missing_deposit: multiOrMissing,
      ...(expiresAtIso ? { expires_at: expiresAtIso } : {}),
    })
    .select()
    .single();
  if (error) throw new Error(`seed row failed: ${error.message}`);
  return data;
}

// The GHL SDK's internal logger prints full axios error config — including the
// Bearer auth header — to stderr when getContact throws (e.g. unknown smoketest
// contact id). That logger fires BEFORE our caller catches the error, so even
// though `getContact` returns null and we fall back to "there", the SDK has
// already leaked the token to stdout. Production never hits this path because
// real refund_requests rows always have a valid contact_id. For the smoke test,
// we silence stderr around the calls that talk to GHL with fixture IDs.
function silenceStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  return () => {
    process.stderr.write = orig;
  };
}

async function cleanup() {
  await supabase
    .from("refund_requests")
    .delete()
    .like("contact_id", `${CONTACT_PREFIX}%`);
}

async function main() {
  console.log("=== Phase 3 lifecycle smoke test ===\n");

  // ---------- Pure helpers (no DB needed) ----------

  // generateRefundToken (already covered by Phase 1 smoke, sanity check shape).
  check(
    "generateRefundToken returns 48-char hex",
    /^[0-9a-f]{48}$/.test(generateRefundToken())
  );

  // deriveDropOffStage truth table.
  check(
    "deriveDropOffStage: TATTOO_BOOKED → tattoo_booked",
    deriveDropOffStage({ currentStage: "TATTOO_BOOKED", consultHappened: true }) === DROP_OFF_STAGES.TATTOO_BOOKED
  );
  check(
    "deriveDropOffStage: CONSULT_APPOINTMENT + happened=true → post_consult",
    deriveDropOffStage({ currentStage: "CONSULT_APPOINTMENT", consultHappened: true }) === DROP_OFF_STAGES.POST_CONSULT
  );
  check(
    "deriveDropOffStage: CONSULT_APPOINTMENT + happened=false → consult_scheduled (Section 2 hidden)",
    deriveDropOffStage({ currentStage: "CONSULT_APPOINTMENT", consultHappened: false }) === DROP_OFF_STAGES.CONSULT_SCHEDULED
  );
  check(
    "deriveDropOffStage: CONSULT_MESSAGE behaves like CONSULT_APPOINTMENT",
    deriveDropOffStage({ currentStage: "CONSULT_MESSAGE", consultHappened: false }) === DROP_OFF_STAGES.CONSULT_SCHEDULED
  );
  check(
    "deriveDropOffStage: QUALIFIED (deposit paid) + no consult → pre_consult",
    deriveDropOffStage({ currentStage: "QUALIFIED", consultHappened: false }) === DROP_OFF_STAGES.PRE_CONSULT
  );
  check(
    "deriveDropOffStage: QUALIFIED + Fireflies says yes → post_consult (Fireflies is §4 source of truth)",
    deriveDropOffStage({ currentStage: "QUALIFIED", consultHappened: true }) === DROP_OFF_STAGES.POST_CONSULT
  );
  check(
    "deriveDropOffStage: null stage + happened=false → pre_consult (safest default)",
    deriveDropOffStage({ currentStage: null, consultHappened: false }) === DROP_OFF_STAGES.PRE_CONSULT
  );

  // showConsultQualityFor truth table.
  check(
    "showConsultQualityFor: pre_consult → false",
    showConsultQualityFor(DROP_OFF_STAGES.PRE_CONSULT) === false
  );
  check(
    "showConsultQualityFor: consult_scheduled → false (per §4)",
    showConsultQualityFor(DROP_OFF_STAGES.CONSULT_SCHEDULED) === false
  );
  check(
    "showConsultQualityFor: post_consult → true",
    showConsultQualityFor(DROP_OFF_STAGES.POST_CONSULT) === true
  );
  check(
    "showConsultQualityFor: tattoo_booked → true",
    showConsultQualityFor(DROP_OFF_STAGES.TATTOO_BOOKED) === true
  );

  // mapDropOffToLastStage + mapReasonCodeToLostReason (analytics rollups, §6.6).
  check(
    "mapDropOffToLastStage: post_consult → 'Consult Completed'",
    mapDropOffToLastStage(DROP_OFF_STAGES.POST_CONSULT) === "Consult Completed"
  );
  check(
    "mapReasonCodeToLostReason: price → price_too_high",
    mapReasonCodeToLostReason("price") === "price_too_high"
  );
  check(
    "mapReasonCodeToLostReason: style_fit AND design_confidence → style_or_design_mismatch",
    mapReasonCodeToLostReason("style_fit") === "style_or_design_mismatch" &&
      mapReasonCodeToLostReason("design_confidence") === "style_or_design_mismatch"
  );

  // validateSubmission rejects bad input.
  check(
    "validateSubmission: rejects missing reason_code",
    validateSubmission({}).length > 0
  );
  check(
    "validateSubmission: rejects 'other' without reason_other_text",
    validateSubmission({ reason_code: "other" }).length > 0
  );
  check(
    "validateSubmission: rejects out-of-range consult score",
    validateSubmission({ reason_code: "price", consult_scores: { q_felt_heard: 9 } }).length > 0
  );
  check(
    "validateSubmission: rejects malformed winback_earliest_month",
    validateSubmission({ reason_code: "price", winback_earliest_month: "2026/12" }).length > 0
  );
  check(
    "validateSubmission: accepts valid minimal submission",
    validateSubmission({ reason_code: "price" }).length === 0
  );
  check(
    "validateSubmission: accepts full submission with all consult scores",
    validateSubmission({
      reason_code: "price",
      consult_scores: { q_felt_heard: 4, q_style_match: 3, q_price_clarity: 2, q_next_steps: 5, q_trust: 4 },
      improvement_text: "Lower price",
      winback_opt_in: true,
      winback_earliest_month: "2026-12",
    }).length === 0
  );

  // ---------- Lifecycle scenarios (DB-touching) ----------
  // Wrap in stderr silencer — the GHL SDK's internal logger dumps the Bearer
  // token when getContact() is called with fixture (non-existent) contact ids.
  // Restored before report so we still see the test summary.
  const restoreStderr = silenceStderr();

  // 1. getRefundRequestByToken — not_found
  {
    const result = await getRefundRequestByToken(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    );
    check(
      "GET unknown token → not_found",
      result.success === false && result.error === "not_found"
    );
  }

  // 2. Seed a pending row, GET it — success
  let postConsultToken;
  {
    const contactId = `${CONTACT_PREFIX}1`;
    postConsultToken = generateRefundToken();
    await seedRow({
      contactId,
      token: postConsultToken,
      dropOffStage: DROP_OFF_STAGES.POST_CONSULT,
      refundAmountCents: 10000,
    });
    const result = await getRefundRequestByToken(postConsultToken);
    check(
      "GET pending post_consult token → success + showConsultQuality=true",
      result.success === true && result.data.showConsultQuality === true
    );
    check(
      "GET pending post_consult token → refundAmountCents and currency surfaced",
      result.data.refundAmountCents === 10000 && result.data.currency === "USD"
    );
  }

  // 3. Seed a pre_consult row, GET it — showConsultQuality=false
  {
    const contactId = `${CONTACT_PREFIX}2`;
    const token = generateRefundToken();
    await seedRow({
      contactId,
      token,
      dropOffStage: DROP_OFF_STAGES.PRE_CONSULT,
    });
    const result = await getRefundRequestByToken(token);
    check(
      "GET pending pre_consult token → showConsultQuality=false (Section 2 hidden)",
      result.success === true && result.data.showConsultQuality === false
    );
  }

  // 4. Seed an expired row, GET it — lazy-expire to 410
  {
    const contactId = `${CONTACT_PREFIX}3`;
    const token = generateRefundToken();
    await seedRow({
      contactId,
      token,
      dropOffStage: DROP_OFF_STAGES.PRE_CONSULT,
      expiresAtIso: new Date(Date.now() - 60_000).toISOString(),
    });
    const result = await getRefundRequestByToken(token);
    check(
      "GET expired token → expired flag set",
      result.success === false && result.error === "expired" && result.expired === true
    );
    // Confirm the row was lazy-updated.
    const { data: refetch } = await supabase
      .from("refund_requests")
      .select("status")
      .eq("token", token)
      .single();
    check(
      "GET expired token also lazy-updates status='expired' in DB",
      refetch?.status === "expired"
    );
  }

  // 5. Seed a completed row, GET it — 410 already_submitted
  {
    const contactId = `${CONTACT_PREFIX}4`;
    const token = generateRefundToken();
    await seedRow({
      contactId,
      token,
      dropOffStage: DROP_OFF_STAGES.POST_CONSULT,
      status: "completed",
    });
    const result = await getRefundRequestByToken(token);
    check(
      "GET completed token → already_submitted",
      result.success === false && result.error === "already_submitted"
    );
  }

  // 6. Submit invalid payload → 400
  {
    const result = await submitRefundRequest(postConsultToken, {});
    check(
      "Submit missing reason_code → httpStatus=400",
      result.success === false && result.httpStatus === 400
    );
  }

  // 7. Submit valid payload → success, fields persist, analytics rolled up
  {
    const result = await submitRefundRequest(
      postConsultToken,
      {
        reason_code: "price",
        consult_scores: {
          q_felt_heard: 4,
          q_style_match: 3,
          q_price_clarity: 2,
          q_next_steps: 5,
          q_trust: 4,
        },
        improvement_text: "More clarity on price tiers up front",
        winback_opt_in: true,
        winback_earliest_month: "2026-12",
      },
      { ip: "1.2.3.4", userAgent: "smoke/1.0" }
    );
    // Phase 5 note: the seeded row has a synthetic square_payment_id which
    // doesn't exist in Square sandbox, so Square's refund call fails. The
    // service falls into the manual-review branch (correct behavior — money
    // didn't move). This is NOT a Phase 3 regression; the lifecycle still
    // captures answers and CAS-flips to completed. To exercise the actual
    // money path against sandbox, write a separate smoke test that seeds a
    // real $1 Square sandbox payment, or rely on the Phase 5 unit suite.
    check(
      "Submit valid → success + refundStatus is resolved (Phase 5 returns refunded OR manual_review)",
      result.success === true &&
        (result.data.refundStatus === "refunded" ||
          result.data.refundStatus === "manual_review")
    );

    // Verify what landed in the DB.
    const { data: row } = await supabase
      .from("refund_requests")
      .select(
        "status, reason_code, lost_reason, last_stage_before_lost, improvement_text, winback_opt_in, winback_earliest_month, consult_scores, submitted_ip, submitted_user_agent, submitted_at"
      )
      .eq("token", postConsultToken)
      .single();
    check(
      "Submit valid → row.status='completed'",
      row?.status === "completed"
    );
    check(
      "Submit valid → reason_code persisted, lost_reason rolled up",
      row?.reason_code === "price" && row?.lost_reason === "price_too_high"
    );
    check(
      "Submit valid → last_stage_before_lost rolled up from drop_off_stage",
      row?.last_stage_before_lost === "Consult Completed"
    );
    check(
      "Submit valid → consult_scores stored as jsonb",
      row?.consult_scores?.q_felt_heard === 4
    );
    check(
      "Submit valid → e-sig audit fields persisted",
      row?.submitted_ip === "1.2.3.4" && row?.submitted_user_agent === "smoke/1.0"
    );
    check(
      "Submit valid → submitted_at populated",
      row?.submitted_at != null
    );
  }

  // 8. Double-submit on the now-completed token → 410
  {
    const result = await submitRefundRequest(postConsultToken, {
      reason_code: "not_now",
    });
    check(
      "Double-submit → httpStatus=410 already_submitted (CAS guard)",
      result.success === false &&
        result.httpStatus === 410 &&
        result.error === "already_submitted"
    );
  }

  // 9. Submit on an expired token → 410 expired
  {
    const contactId = `${CONTACT_PREFIX}5`;
    const token = generateRefundToken();
    await seedRow({
      contactId,
      token,
      dropOffStage: DROP_OFF_STAGES.PRE_CONSULT,
      expiresAtIso: new Date(Date.now() - 60_000).toISOString(),
    });
    const result = await submitRefundRequest(token, { reason_code: "price" });
    check(
      "Submit on expired token → httpStatus=410 expired",
      result.success === false && result.httpStatus === 410 && result.error === "expired"
    );
  }

  // 10. Submit on a multi/missing deposit row → refundStatus='manual_review'
  {
    const contactId = `${CONTACT_PREFIX}6`;
    const token = generateRefundToken();
    await seedRow({
      contactId,
      token,
      dropOffStage: DROP_OFF_STAGES.PRE_CONSULT,
      multiOrMissing: true,
      refundAmountCents: null,
    });
    const result = await submitRefundRequest(token, { reason_code: "price" });
    check(
      "Submit on multi/missing deposit row → refundStatus='manual_review'",
      result.success === true &&
        result.data.refundStatus === "manual_review" &&
        result.data.showRefundPath === false
    );
  }

  // 11. locatePaidDeposit on unknown contact → missing branch
  {
    const result = await locatePaidDeposit(`${CONTACT_PREFIX}nonexistent`);
    check(
      "locatePaidDeposit unknown contact → { missing: true }",
      result.missing === true
    );
  }

  // 12. consultDidHappen on unknown contact → false/unknown (no Fireflies, no GHL hit either since we pass a synthetic contact below)
  {
    const synthetic = { id: `${CONTACT_PREFIX}nonexistent2`, customField: {} };
    const result = await consultDidHappen(synthetic.id, synthetic);
    check(
      "consultDidHappen unknown contact → happened=false validity='unknown'",
      result.happened === false && result.validity === "unknown"
    );
  }

  // ---------- Cleanup + report ----------
  restoreStderr();
  await cleanup();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail === 0) {
    console.log("🎉 Phase 3 STOP & VERIFY: PASS");
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("\n❌ Smoke test crashed:", err.stack || err.message);
  try {
    await cleanup();
  } catch (cleanupErr) {
    console.error("Cleanup also failed:", cleanupErr.message);
  }
  process.exit(1);
});
