jest.mock("../../clients/ghlCalendarClient", () => ({
  listAppointmentsForContact: jest.fn(async () => []),
  getCalendarFreeSlots: jest.fn(async () => []),
}));

const { getAvailableSlots } = require("../bookingController");
const {
  listAppointmentsForContact,
  getCalendarFreeSlots,
} = require("../../clients/ghlCalendarClient");
const { CALENDARS } = require("../../config/constants");

/** Free slots as GHL returns them, spread across separate days. */
function freeSlots() {
  return [
    { startTime: "2025-12-15T17:00:00.000Z", endTime: "2025-12-15T17:30:00.000Z" },
    { startTime: "2025-12-16T18:00:00.000Z", endTime: "2025-12-16T18:30:00.000Z" },
    { startTime: "2025-12-17T19:00:00.000Z", endTime: "2025-12-17T19:30:00.000Z" },
  ];
}

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
    expect(getCalendarFreeSlots).not.toHaveBeenCalled();
  });

  test("USE_SYNTHETIC_SLOTS=true forces synthetic slots outside tests too", async () => {
    process.env.NODE_ENV = "production";
    process.env.USE_SYNTHETIC_SLOTS = "true";
    const slots = await getAvailableSlots({});
    expect(slots.length).toBeGreaterThan(0);
    expect(getCalendarFreeSlots).not.toHaveBeenCalled();
  });

  test("queries the real GHL calendar in non-test env", async () => {
    process.env.NODE_ENV = "production";
    process.env.USE_SYNTHETIC_SLOTS = "false";
    getCalendarFreeSlots.mockResolvedValueOnce(freeSlots());

    const slots = await getAvailableSlots({
      context: { contact: { id: "contact123" } },
    });

    expect(getCalendarFreeSlots).toHaveBeenCalledTimes(1);
    const [calendarId, startDate, endDate] = getCalendarFreeSlots.mock.calls[0];
    expect(calendarId).toBe(CALENDARS.JOAN_ONLINE);
    expect(endDate.getTime()).toBeGreaterThan(startDate.getTime());

    expect(slots.length).toBeGreaterThan(0);
    // Real slots are decorated with display text before they reach the lead.
    expect(slots.every((s) => typeof s.displayText === "string" && s.displayText)).toBe(true);

    // getAvailableSlots asks the calendar for free slots; it does NOT dedupe
    // against the contact's own appointments. That belongs to the callers in
    // app.js / refundRequestService.
    expect(listAppointmentsForContact).not.toHaveBeenCalled();
  });

  test("falls back to synthetic slots when GHL returns nothing", async () => {
    process.env.NODE_ENV = "production";
    process.env.USE_SYNTHETIC_SLOTS = "false";
    getCalendarFreeSlots.mockResolvedValueOnce([]);

    const slots = await getAvailableSlots({});

    expect(getCalendarFreeSlots).toHaveBeenCalledTimes(1);
    expect(slots.length).toBeGreaterThan(0);
  });

  test("falls back to synthetic slots when the calendar call throws", async () => {
    process.env.NODE_ENV = "production";
    process.env.USE_SYNTHETIC_SLOTS = "false";
    getCalendarFreeSlots.mockRejectedValueOnce(new Error("GHL 401"));

    const slots = await getAvailableSlots({});

    // A calendar outage must never leave the setter with zero options.
    expect(slots.length).toBeGreaterThan(0);
  });

  test("returns at most four options", async () => {
    process.env.NODE_ENV = "production";
    process.env.USE_SYNTHETIC_SLOTS = "false";
    getCalendarFreeSlots.mockResolvedValueOnce([
      ...freeSlots(),
      { startTime: "2025-12-18T17:00:00.000Z", endTime: "2025-12-18T17:30:00.000Z" },
      { startTime: "2025-12-19T17:00:00.000Z", endTime: "2025-12-19T17:30:00.000Z" },
      { startTime: "2025-12-20T17:00:00.000Z", endTime: "2025-12-20T17:30:00.000Z" },
    ]);

    const slots = await getAvailableSlots({});
    expect(slots.length).toBeLessThanOrEqual(4);
  });
});
