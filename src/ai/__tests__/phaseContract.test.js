const { derivePhaseFromFields } = require("../phaseContract");
const { AI_PHASES } = require("../../config/constants");

describe("derivePhaseFromFields", () => {
  test("INTAKE when placement is missing", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: null,
      tattooSize: null,
    });
    expect(phase).toBe(AI_PHASES.INTAKE);
  });

  test("QUALIFICATION when summary + placement + size present but no timeline", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: "Shoulder",
      tattooSize: "4 inches",
    });
    expect(phase).toBe(AI_PHASES.QUALIFICATION);
  });

  test("CONSULT_PATH when timeline captured but consult not chosen", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: "Shoulder",
      tattooSize: "4 inches",
      timeline: "December",
    });
    expect(phase).toBe(AI_PHASES.CONSULT_PATH);
  });

  test("SCHEDULING when consult chosen and slots sent", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: "Shoulder",
      tattooSize: "4 inches",
      timeline: "December",
      consultationType: "appointment",
      timesSent: true,
    });
    expect(phase).toBe(AI_PHASES.SCHEDULING);
  });

  test("DEPOSIT_PENDING when hold appointment exists", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: "Shoulder",
      tattooSize: "4 inches",
      timeline: "December",
      consultationType: "appointment",
      holdAppointmentId: "apt_123",
    });
    expect(phase).toBe(AI_PHASES.DEPOSIT_PENDING);
  });

  test("DEPOSIT_PENDING when deposit link sent and not paid", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: "Shoulder",
      tattooSize: "4 inches",
      timeline: "December",
      consultationType: "appointment",
      depositLinkSent: true,
      depositPaid: false,
    });
    expect(phase).toBe(AI_PHASES.DEPOSIT_PENDING);
  });

  test("QUALIFIED when deposit is paid and no appointment booked", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: "Shoulder",
      tattooSize: "4 inches",
      depositPaid: true,
    });
    expect(phase).toBe(AI_PHASES.QUALIFIED);
  });

  test("BOOKED when appointment booked and deposit paid", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: "Shoulder",
      tattooSize: "4 inches",
      depositPaid: true,
      appointmentBooked: true,
    });
    expect(phase).toBe(AI_PHASES.BOOKED);
  });

  test("QUALIFICATION when size is artist_guided", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: "Shoulder",
      tattooSize: "artist_guided",
    });
    expect(phase).toBe(AI_PHASES.QUALIFICATION);
  });

  test("DISCOVERY fallback when summary and placement exist but size/timeline missing", () => {
    const phase = derivePhaseFromFields({
      tattooSummary: "Bouquet",
      tattooPlacement: "Shoulder",
    });
    expect(phase).toBe(AI_PHASES.DISCOVERY);
  });
});
