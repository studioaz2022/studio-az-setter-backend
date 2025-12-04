const { determineStageFromContext } = require("../src/ai/opportunityManager");
const { AI_PHASES, OPPORTUNITY_STAGES } = require("../src/config/constants");

describe("determineStageFromContext", () => {
  it("returns QUALIFIED when deposit is paid", () => {
    const stage = determineStageFromContext({
      aiPhase: AI_PHASES.DISCOVERY,
      depositPaid: true,
      depositLinkSent: true,
    });
    expect(stage).toBe(OPPORTUNITY_STAGES.QUALIFIED);
  });

  it("returns CONSULT_MESSAGE when consult type is message", () => {
    const stage = determineStageFromContext({
      consultType: "message",
      depositPaid: false,
    });
    expect(stage).toBe(OPPORTUNITY_STAGES.CONSULT_MESSAGE);
  });

  it("returns COLD_NURTURE_LOST when lead is marked lost", () => {
    const stage = determineStageFromContext({
      lost: true,
      depositPaid: false,
      depositLinkSent: false,
    });
    expect(stage).toBe(OPPORTUNITY_STAGES.COLD_NURTURE_LOST);
  });

  it("falls back to discovery when AI phase is discovery and no other signals", () => {
    const stage = determineStageFromContext({
      aiPhase: AI_PHASES.DISCOVERY,
      depositPaid: false,
      depositLinkSent: false,
    });
    expect(stage).toBe(OPPORTUNITY_STAGES.DISCOVERY);
  });
});

