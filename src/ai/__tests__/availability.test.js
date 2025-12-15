jest.mock("../../clients/ghlCalendarClient", () => ({
  listAppointmentsForContact: jest.fn(async () => []),
}));

const { getAvailableSlots } = require("../bookingController");
const { listAppointmentsForContact } = require("../../clients/ghlCalendarClient");

describe("getAvailableSlots", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  test("uses synthetic slots when NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const slots = await getAvailableSlots({});
    expect(slots.length).toBeGreaterThan(0);
    expect(listAppointmentsForContact).not.toHaveBeenCalled();
  });

  test("calls calendar client in non-test env", async () => {
    process.env.NODE_ENV = "production";
    process.env.USE_SYNTHETIC_SLOTS = "false";

    listAppointmentsForContact.mockResolvedValueOnce([
      { startTime: "2025-12-15T17:00:00.000Z" },
    ]);

    const slots = await getAvailableSlots({
      context: { contact: { id: "contact123" } },
    });

    expect(listAppointmentsForContact).toHaveBeenCalledWith("contact123");
    expect(slots.length).toBeGreaterThan(0);
  });
});
