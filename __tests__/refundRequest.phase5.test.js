/**
 * Phase 5 — submit flow tests (money + CRM + notifications).
 *
 * The Phase 3 smoke test (scripts/refund-request-smoketest.js) hits the live
 * Supabase project to verify lifecycle + persistence. This unit suite mocks
 * everything below the Supabase boundary so we can exercise:
 *   - Single-deposit auto path (Square OK)
 *   - Single-deposit Square failure → manual review escalation
 *   - Multi/missing deposit branch
 *   - Lost transition + winback tag fire on both branches
 *
 * Mocks are defined BEFORE require() of the SUT.
 */

// ---- Mock the Supabase client used by refundRequestService ----
// Jest hoists jest.mock() calls above requires; the factory cannot reference
// out-of-scope variables. We require the fake INSIDE the factory.
jest.mock("@supabase/supabase-js", () => {
  const fake = require("./helpers/fakeSupabase");
  return { createClient: jest.fn(() => fake.client) };
});
const fakeSupabase = require("./helpers/fakeSupabase");

// ---- Mock Square / Financial / GHL / opportunity / notifications ----
jest.mock("../src/payments/squareClient", () => ({
  refundPayment: jest.fn(),
}));
jest.mock("../src/clients/financialTracking", () => ({
  recordTransaction: jest.fn(async (row) => ({ id: "tx_refund_1", ...row })),
}));
jest.mock("../src/clients/ghlClient", () => ({
  getContact: jest.fn(async () => ({
    id: "c_lionel_client",
    firstName: "Maria",
    lastName: "Garcia",
    customField: {},
  })),
  sendConversationMessage: jest.fn(async () => ({})),
  addTagsToContact: jest.fn(async () => ({})),
}));
jest.mock("../src/clients/ghlOpportunityClient", () => ({
  getOpportunitiesByContact: jest.fn(async () => []),
}));
jest.mock("../src/ai/opportunityManager", () => ({
  transitionToStage: jest.fn(async () => ({ opportunityId: "opp_1", stageKey: "COLD_NURTURE_LOST" })),
}));
jest.mock("../src/services/taskNotifications", () => ({
  sendPushToGhlUser: jest.fn(async () => ({ sent: 1, failed: 0 })),
}));
jest.mock("../src/rentTracker/serviceIncomeWriter", () => ({
  writeServiceIncome: jest.fn(async () => ({ written: true, id: "si_1" })),
}));

// SUT
const {
  submitRefundRequest,
} = require("../src/refundRequest/refundRequestService");

const { refundPayment } = require("../src/payments/squareClient");
const { recordTransaction } = require("../src/clients/financialTracking");
const { transitionToStage } = require("../src/ai/opportunityManager");
const { sendPushToGhlUser } = require("../src/services/taskNotifications");
const { addTagsToContact } = require("../src/clients/ghlClient");
const { writeServiceIncome } = require("../src/rentTracker/serviceIncomeWriter");

const VALID_ANSWERS = {
  reason_code: "price",
  consult_scores: {
    q_felt_heard: 4,
    q_style_match: 3,
    q_price_clarity: 2,
    q_next_steps: 5,
    q_trust: 4,
  },
  improvement_text: "Lower price",
  winback_opt_in: true,
  winback_earliest_month: "2026-12",
};

describe("Phase 5 — submitRefundRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fakeSupabase.reset();
  });

  test("single-deposit OK: Square refund → ledger row → Lost → winback tag → InstantDB mirror", async () => {
    fakeSupabase.seedRefundRequest({
      token: "tok_single_ok",
      contact_id: "c_lionel_client",
      drop_off_stage: "post_consult",
      refund_amount_cents: 10000,
      currency: "USD",
      multi_or_missing_deposit: false,
      square_payment_id: "sq_pay_orig_1",
      status: "pending",
    });
    fakeSupabase.seedOriginalDepositTxn({
      square_payment_id: "sq_pay_orig_1",
      contact_id: "c_lionel_client",
      contact_name: "Maria Garcia",
      artist_ghl_id: "art_lionel",
      gross_amount: 100,
      shop_amount: 30,
      artist_amount: 70,
      shop_percentage: 30,
      artist_percentage: 70,
      location_id: "loc_tattoo",
    });

    refundPayment.mockResolvedValueOnce({
      refundId: "sq_pay_orig_1_REF",
      status: "PENDING",
      amountCents: 10000,
    });

    const result = await submitRefundRequest("tok_single_ok", VALID_ANSWERS, {
      ip: "1.2.3.4",
      userAgent: "test/1.0",
    });

    expect(result.success).toBe(true);
    expect(result.data.refundStatus).toBe("refunded");
    expect(result.data.showRefundPath).toBe(true);
    expect(result.data.refundAmountCents).toBe(10000);

    // Square called with the token as idempotency key.
    expect(refundPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "sq_pay_orig_1",
        amountCents: 10000,
        idempotencyKey: "tok_single_ok",
      })
    );

    // Ledger row was inserted with the deposit's exact split (override path).
    expect(recordTransaction).toHaveBeenCalledTimes(1);
    const ledgerCall = recordTransaction.mock.calls[0][0];
    expect(ledgerCall.transactionType).toBe("refund");
    expect(ledgerCall.paymentRecipient).toBe("shop");
    expect(ledgerCall.grossAmount).toBe(100);
    expect(ledgerCall.squarePaymentId).toBe("sq_pay_orig_1_REF"); // refund id, not orig
    expect(ledgerCall.shopPercentageOverride).toBe(30);
    expect(ledgerCall.artistPercentageOverride).toBe(70);
    expect(ledgerCall.shopAmountOverride).toBe(30);
    expect(ledgerCall.artistAmountOverride).toBe(70);
    expect(ledgerCall.locationId).toBe("loc_tattoo");
    expect(ledgerCall.artistId).toBe("art_lionel");

    // Lost transition called with refund_type = deposit_refunded.
    expect(transitionToStage).toHaveBeenCalledWith(
      "c_lionel_client",
      "COLD_NURTURE_LOST",
      expect.objectContaining({
        refundType: "deposit_refunded",
        lostReason: "price_too_high",
        lastStageBeforeLostOverride: "Consult Completed",
        allowRegression: true,
      })
    );

    // Winback tag added.
    expect(addTagsToContact).toHaveBeenCalledWith("c_lionel_client", [
      "winback-2026-12",
    ]);

    // InstantDB mirror was called with negative amount.
    expect(writeServiceIncome).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: -100,
        type: "refund",
        method: "square",
        squarePaymentId: "sq_pay_orig_1_REF",
      })
    );

    // No owner/admin push on the happy path.
    expect(sendPushToGhlUser).not.toHaveBeenCalled();

    // Final refund_requests update wrote refund_status + refund_type + square_refund_id.
    const finalRow = fakeSupabase.getRow("tok_single_ok");
    expect(finalRow.status).toBe("completed");
    expect(finalRow.refund_status).toBe("refunded");
    expect(finalRow.refund_type).toBe("deposit_refunded");
    expect(finalRow.square_refund_id).toBe("sq_pay_orig_1_REF");
    expect(finalRow.last_stage_before_lost).toBe("Consult Completed");
    expect(finalRow.lost_reason).toBe("price_too_high");
  });

  test("Square refund failure → refund_status='failed' + push owner+admin + still Lost transition", async () => {
    fakeSupabase.seedRefundRequest({
      token: "tok_single_sqfail",
      contact_id: "c_lionel_client",
      drop_off_stage: "post_consult",
      refund_amount_cents: 10000,
      currency: "USD",
      multi_or_missing_deposit: false,
      square_payment_id: "sq_pay_orig_2",
      status: "pending",
    });
    fakeSupabase.seedOriginalDepositTxn({
      square_payment_id: "sq_pay_orig_2",
      contact_id: "c_lionel_client",
      artist_ghl_id: "art_lionel",
      gross_amount: 100,
      shop_amount: 30,
      artist_amount: 70,
      shop_percentage: 30,
      artist_percentage: 70,
      location_id: "loc_tattoo",
    });

    refundPayment.mockRejectedValueOnce(
      new Error("Square refund failed (INSUFFICIENT_FUNDS): no balance")
    );

    const result = await submitRefundRequest("tok_single_sqfail", VALID_ANSWERS);

    expect(result.success).toBe(true); // form still shows success to the user
    expect(result.data.refundStatus).toBe("manual_review");
    expect(result.data.showRefundPath).toBe(false);

    // No ledger row inserted on Square failure.
    expect(recordTransaction).not.toHaveBeenCalled();
    expect(writeServiceIncome).not.toHaveBeenCalled();

    // Lost transition fires regardless, with refundType=null (no money moved).
    expect(transitionToStage).toHaveBeenCalledWith(
      "c_lionel_client",
      "COLD_NURTURE_LOST",
      expect.objectContaining({
        refundType: null,
        lostReason: "price_too_high",
      })
    );

    // Owner + admin pushed.
    expect(sendPushToGhlUser).toHaveBeenCalledTimes(2);
    expect(sendPushToGhlUser).toHaveBeenNthCalledWith(
      1,
      "1kFG5FWdUDhXLUX46snG", // LIONEL
      expect.any(Function)
    );
    expect(sendPushToGhlUser).toHaveBeenNthCalledWith(
      2,
      "uAWhIMemqUPJC1SqCyDR", // MARIA
      expect.any(Function)
    );

    // refund_status='failed' persisted.
    const finalRow = fakeSupabase.getRow("tok_single_sqfail");
    expect(finalRow.status).toBe("completed");
    expect(finalRow.refund_status).toBe("failed");
    expect(finalRow.refund_type).toBeNull();
    expect(finalRow.square_refund_id).toBeNull();
  });

  test("multi/missing deposit branch: no Square call, manual review push, Lost transition still fires", async () => {
    fakeSupabase.seedRefundRequest({
      token: "tok_multi",
      contact_id: "c_lionel_client",
      drop_off_stage: "pre_consult",
      refund_amount_cents: null,
      currency: "USD",
      multi_or_missing_deposit: true,
      square_payment_id: null,
      status: "pending",
    });

    const result = await submitRefundRequest("tok_multi", VALID_ANSWERS);

    expect(result.success).toBe(true);
    expect(result.data.refundStatus).toBe("manual_review");
    expect(result.data.showRefundPath).toBe(false);

    // Square never called.
    expect(refundPayment).not.toHaveBeenCalled();
    expect(recordTransaction).not.toHaveBeenCalled();
    expect(writeServiceIncome).not.toHaveBeenCalled();

    // Push delivered to owner + admin.
    expect(sendPushToGhlUser).toHaveBeenCalledTimes(2);

    // Lost transition with refundType=null (settlement pending owner).
    expect(transitionToStage).toHaveBeenCalledWith(
      "c_lionel_client",
      "COLD_NURTURE_LOST",
      expect.objectContaining({
        refundType: null,
        lostReason: "price_too_high",
        // pre_consult → "Deposit Paid" per the mapping.
        lastStageBeforeLostOverride: "Deposit Paid",
      })
    );

    // Winback tag still works on this branch.
    expect(addTagsToContact).toHaveBeenCalledWith("c_lionel_client", [
      "winback-2026-12",
    ]);
  });

  test("Lost transition GHL failure does NOT prevent the submit from succeeding", async () => {
    fakeSupabase.seedRefundRequest({
      token: "tok_lost_fail",
      contact_id: "c_lionel_client",
      drop_off_stage: "post_consult",
      refund_amount_cents: 10000,
      currency: "USD",
      multi_or_missing_deposit: false,
      square_payment_id: "sq_pay_orig_3",
      status: "pending",
    });
    fakeSupabase.seedOriginalDepositTxn({
      square_payment_id: "sq_pay_orig_3",
      artist_ghl_id: "art_lionel",
      gross_amount: 100,
      shop_amount: 30,
      artist_amount: 70,
      shop_percentage: 30,
      artist_percentage: 70,
      location_id: "loc_tattoo",
    });

    refundPayment.mockResolvedValueOnce({
      refundId: "sq_pay_orig_3_REF",
      status: "PENDING",
      amountCents: 10000,
    });

    transitionToStage.mockRejectedValueOnce(
      new Error("GHL 500: pipeline service unavailable")
    );

    const result = await submitRefundRequest("tok_lost_fail", VALID_ANSWERS);

    // Submit still succeeds — money already moved.
    expect(result.success).toBe(true);
    expect(result.data.refundStatus).toBe("refunded");

    // Money side ran.
    expect(refundPayment).toHaveBeenCalled();
    expect(recordTransaction).toHaveBeenCalled();
  });

  test("double-submit returns 410 already_submitted via the CAS guard", async () => {
    fakeSupabase.seedRefundRequest({
      token: "tok_double",
      contact_id: "c_lionel_client",
      drop_off_stage: "pre_consult",
      refund_amount_cents: 5000,
      currency: "USD",
      multi_or_missing_deposit: false,
      square_payment_id: "sq_pay_orig_4",
      status: "completed", // already done
    });
    const result = await submitRefundRequest("tok_double", VALID_ANSWERS);
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(410);
    expect(result.error).toBe("already_submitted");
    expect(refundPayment).not.toHaveBeenCalled();
  });

  test("validation failure: missing reason_code → 400", async () => {
    const result = await submitRefundRequest("tok_x", {});
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(400);
  });
});
