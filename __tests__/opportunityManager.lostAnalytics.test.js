/**
 * Phase 4 — Lost-deal analytics on transitionToStage (§6.6).
 *
 * Verifies that:
 *   - last_stage_before_lost is captured from the FROM-stage (or override).
 *   - lost_reason and refund_type round-trip from options to updateSystemFields.
 *   - Idempotency: a second transitionToStage(... LOST ...) call when
 *     currentStage is already LOST does NOT overwrite last_stage_before_lost.
 *   - Non-LOST transitions never touch the three new fields.
 *
 * The transitionToStage function has many GHL/DB collaborators — we mock the
 * minimum (ensureOpportunity, upsertOpportunity, updateSystemFields) and let
 * the rest be no-ops via mocked clients.
 */

// === Mocks must be defined BEFORE require() of the SUT. ===
jest.mock("../src/clients/ghlClient", () => ({
  getContact: jest.fn(async () => ({
    id: "c1",
    firstName: "Maria",
    lastName: "Garcia",
    customField: {},
  })),
  updateSystemFields: jest.fn(async () => ({})),
  getConversationHistory: jest.fn(async () => []),
}));

jest.mock("../src/clients/ghlOpportunityClient", () => ({
  upsertOpportunity: jest.fn(async () => ({
    opportunity: { id: "opp1", pipelineStageId: "stage-cold-nurture-lost" },
  })),
  updateOpportunityStage: jest.fn(async () => ({})),
  updateOpportunityValue: jest.fn(async () => ({})),
  getOpportunitiesByContact: jest.fn(async () => [
    { id: "opp1", pipelineStageId: "stage-qualified" },
  ]),
  addOpportunityNote: jest.fn(async () => ({})),
  getOpportunity: jest.fn(async () => ({ opportunity: { name: "Maria Garcia" } })),
  updateOpportunity: jest.fn(async () => ({})),
}));

jest.mock("../src/clients/appEventClient", () => ({
  notifyPhaseChanged: jest.fn(async () => ({})),
}));

jest.mock("../src/ai/contextBuilder", () => ({
  generateComprehensiveConversationSummary: jest.fn(() => "summary"),
  appendToConversationHistory: jest.fn((prev, next) => `${prev}\n${next}`),
}));

// Stub the pipeline config so getStageId returns a deterministic id for the
// stage keys we exercise. The real config requires GHL env vars at load time
// in some paths, which we don't want to depend on in unit tests.
jest.mock("../src/config/pipelineConfig", () => {
  const PIPELINE_STAGE_CONFIG = {
    INTAKE:                { id: "stage-intake" },
    DISCOVERY:             { id: "stage-discovery" },
    DEPOSIT_PENDING:       { id: "stage-deposit-pending" },
    QUALIFIED:             { id: "stage-qualified" },
    CONSULT_APPOINTMENT:   { id: "stage-consult-appointment" },
    CONSULT_MESSAGE:       { id: "stage-consult-message" },
    TATTOO_BOOKED:         { id: "stage-tattoo-booked" },
    COLD_NURTURE_LOST:     { id: "stage-cold-nurture-lost" },
    COMPLETED:             { id: "stage-completed" },
  };
  const PIPELINE_STAGE_ORDER = Object.keys(PIPELINE_STAGE_CONFIG);
  return {
    PIPELINE_STAGE_CONFIG,
    PIPELINE_STAGE_ORDER,
    getStageId: (key) => PIPELINE_STAGE_CONFIG[key]?.id || null,
  };
});

const { transitionToStage } = require("../src/ai/opportunityManager");
const { updateSystemFields } = require("../src/clients/ghlClient");
const { getOpportunitiesByContact } = require("../src/clients/ghlOpportunityClient");

function lastSystemFieldsCall() {
  const calls = updateSystemFields.mock.calls;
  return calls[calls.length - 1]?.[1] || {};
}

describe("transitionToStage → COLD_NURTURE_LOST writes Lost-deal analytics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("auto-derives last_stage_before_lost from currentStage (Deposit Paid)", async () => {
    // Contact currently sits at QUALIFIED (= "Deposit Paid" per §6.6 mapping).
    getOpportunitiesByContact.mockResolvedValueOnce([
      { id: "opp1", pipelineStageId: "stage-qualified" },
    ]);
    await transitionToStage("c1", "COLD_NURTURE_LOST", {
      allowRegression: true,
    });
    const last = lastSystemFieldsCall();
    expect(last.last_stage_before_lost).toBe("Deposit Paid");
    // No reason/type supplied → those keys must be absent (not undefined).
    expect(last).not.toHaveProperty("lost_reason");
    expect(last).not.toHaveProperty("refund_type");
  });

  test("uses lastStageBeforeLostOverride when caller knows better (Consult Completed)", async () => {
    // From the refund form's perspective: drop_off_stage=post_consult
    // → "Consult Completed" — which CANNOT be derived from CONSULT_APPOINTMENT
    // (that maps to "Consult Scheduled"). The override path is the §6.6 fix.
    getOpportunitiesByContact.mockResolvedValueOnce([
      { id: "opp1", pipelineStageId: "stage-consult-appointment" },
    ]);
    await transitionToStage("c1", "COLD_NURTURE_LOST", {
      allowRegression: true,
      lastStageBeforeLostOverride: "Consult Completed",
      lostReason: "price_too_high",
      refundType: "deposit_refunded",
    });
    const last = lastSystemFieldsCall();
    expect(last.last_stage_before_lost).toBe("Consult Completed");
    expect(last.lost_reason).toBe("price_too_high");
    expect(last.refund_type).toBe("deposit_refunded");
  });

  test("Tattoo Booked → 'Tattoo Booked' when canceled post-booking", async () => {
    getOpportunitiesByContact.mockResolvedValueOnce([
      { id: "opp1", pipelineStageId: "stage-tattoo-booked" },
    ]);
    await transitionToStage("c1", "COLD_NURTURE_LOST", {
      allowRegression: true,
      lostReason: "scheduling_conflict",
      refundType: "no_refund",
    });
    const last = lastSystemFieldsCall();
    expect(last.last_stage_before_lost).toBe("Tattoo Booked");
    expect(last.lost_reason).toBe("scheduling_conflict");
    expect(last.refund_type).toBe("no_refund");
  });

  test("idempotency: when currentStage is ALREADY LOST, do not overwrite last_stage_before_lost", async () => {
    getOpportunitiesByContact.mockResolvedValueOnce([
      { id: "opp1", pipelineStageId: "stage-cold-nurture-lost" },
    ]);
    await transitionToStage("c1", "COLD_NURTURE_LOST", {
      allowRegression: true,
      lostReason: "other",
    });
    const last = lastSystemFieldsCall();
    // last_stage_before_lost must NOT appear — preserving whatever was set
    // on the first transition. Otherwise we'd overwrite it with
    // "Cold Nurture Lost" or null.
    expect(last).not.toHaveProperty("last_stage_before_lost");
    // Reason/type can still be updated by a follow-up call (e.g. an owner
    // marking refund_type after manual settlement).
    expect(last.lost_reason).toBe("other");
  });

  test("non-LOST transitions never write the three Lost-analytics fields", async () => {
    getOpportunitiesByContact.mockResolvedValueOnce([
      { id: "opp1", pipelineStageId: "stage-discovery" },
    ]);
    await transitionToStage("c1", "QUALIFIED", {});
    const last = lastSystemFieldsCall();
    expect(last).not.toHaveProperty("last_stage_before_lost");
    expect(last).not.toHaveProperty("lost_reason");
    expect(last).not.toHaveProperty("refund_type");
  });

  test("LOST from unknown/null stage → no last_stage_before_lost written (defensive)", async () => {
    // Edge: contact has no opportunity history. We DO move to LOST but we
    // shouldn't lie about the prior stage.
    getOpportunitiesByContact.mockResolvedValueOnce([
      { id: "opp1", pipelineStageId: "stage-that-doesnt-exist" },
    ]);
    await transitionToStage("c1", "COLD_NURTURE_LOST", {
      allowRegression: true,
      lostReason: "personal_or_medical",
    });
    const last = lastSystemFieldsCall();
    expect(last).not.toHaveProperty("last_stage_before_lost");
    expect(last.lost_reason).toBe("personal_or_medical");
  });
});

describe("deriveLastStageBeforeLost mapping (§6.6)", () => {
  // Internal helper is not exported; we cover its truth-table via
  // transitionToStage calls above. This test asserts the stage-by-stage
  // labels match the §6.6 table.
  const cases = [
    ["INTAKE", "Intake"],
    ["DISCOVERY", "Discovery"],
    ["DEPOSIT_PENDING", "Deposit Pending"],
    ["QUALIFIED", "Deposit Paid"],
    ["CONSULT_APPOINTMENT", "Consult Scheduled"],
    ["CONSULT_MESSAGE", "Consult Scheduled"],
    ["TATTOO_BOOKED", "Tattoo Booked"],
  ];

  test.each(cases)("from %s → '%s'", async (fromStage, label) => {
    const stageId = `stage-${fromStage.toLowerCase().replace(/_/g, "-")}`;
    getOpportunitiesByContact.mockResolvedValueOnce([
      { id: "opp1", pipelineStageId: stageId },
    ]);
    await transitionToStage("c1", "COLD_NURTURE_LOST", {
      allowRegression: true,
    });
    const last = lastSystemFieldsCall();
    expect(last.last_stage_before_lost).toBe(label);
  });
});
