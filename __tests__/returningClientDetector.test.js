const { detectReturningClient } = require("../src/ai/returningClientDetector");

describe("detectReturningClient", () => {
  it("returns true when returning_client field is set", () => {
    const contact = { customField: { returning_client: "Yes" } };
    const result = detectReturningClient({ contact, appointments: [] });
    expect(result.isReturningClient).toBe(true);
  });

  it("returns true when past confirmed appointment exists", () => {
    const contact = { customField: {}, tags: [] };
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const appointments = [
      { startTime: yesterday, appointmentStatus: "confirmed", assignedUserId: "artist-1" },
    ];
    const result = detectReturningClient({ contact, appointments });
    expect(result.isReturningClient).toBe(true);
    expect(result.appointmentStats.pastAppointmentCount).toBe(1);
  });

  it("requires more than lifetime value alone to mark returning", () => {
    const contact = { customField: { client_lifetime_value: "150" }, tags: [] };
    const result = detectReturningClient({ contact, appointments: [] });
    expect(result.isReturningClient).toBe(false);
  });

  it("treats lifetime value plus returning-sounding notes as returning", () => {
    const contact = {
      customField: { client_lifetime_value: "150" },
      notes: "Client back for another tattoo this fall",
    };
    const result = detectReturningClient({ contact, appointments: [] });
    expect(result.isReturningClient).toBe(true);
  });
});
