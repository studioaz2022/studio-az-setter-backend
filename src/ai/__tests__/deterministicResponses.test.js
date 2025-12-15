jest.mock("../bookingController", () => ({
  generateSuggestedSlots: jest.fn(() => [
    { startTime: "2025-01-01T17:00:00.000Z", displayText: "Wed 5:00 PM" },
    { startTime: "2025-01-01T18:00:00.000Z", displayText: "Wed 6:00 PM" },
  ]),
  getAvailableSlots: jest.fn(async () => [
    { startTime: "2025-01-01T17:00:00.000Z", displayText: "Wed 5:00 PM" },
    { startTime: "2025-01-01T18:00:00.000Z", displayText: "Wed 6:00 PM" },
  ]),
  formatSlotDisplay: jest.fn((d) => d.toISOString()),
  parseTimeSelection: jest.fn((text, slots) => slots[0]),
  createConsultAppointment: jest.fn(async () => ({ id: "apt_123" })),
}));

jest.mock("../../../ghlClient", () => ({
  updateSystemFields: jest.fn(async () => ({})),
  sendConversationMessage: jest.fn(async () => ({})),
}));

jest.mock("../../payments/squareClient", () => ({
  createDepositLinkForContact: jest.fn(async () => ({ url: "https://pay.test/link" })),
}));

jest.mock("../../clients/ghlCalendarClient", () => ({
  updateAppointmentStatus: jest.fn(async () => ({})),
}));

const { buildDeterministicResponse } = require("../deterministicResponses");
const { updateSystemFields } = require("../../../ghlClient");
const {
  generateSuggestedSlots,
  getAvailableSlots,
  parseTimeSelection,
  createConsultAppointment,
} = require("../bookingController");
const { createDepositLinkForContact } = require("../../payments/squareClient");
const { updateAppointmentStatus } = require("../../clients/ghlCalendarClient");

describe("buildDeterministicResponse", () => {
  test("returns slots for scheduling intent", async () => {
    const intents = { scheduling_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {},
      contact: { id: "contact123" },
    });

    expect(res.bubbles[0]).toContain("I pulled a few openings");
    expect(res.bubbles[0]).toContain("consult with an artist");
    expect(res.bubbles[0]).toContain("1)");
    expect(res.bubbles[0]).toContain("2)");
    expect(updateSystemFields).toHaveBeenCalledWith("contact123", expect.objectContaining({
      last_sent_slots: expect.any(String),
      times_sent: true,
    }));
  });

  test("fallback when no slots", async () => {
    generateSuggestedSlots.mockImplementationOnce(() => []);
    getAvailableSlots.mockResolvedValueOnce([]);
    const intents = { scheduling_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {},
      contact: { id: "contact123" },
    });

    expect(res.bubbles[0]).toMatch(/day\(s\).*time window/i);
  });

  test("slot selection creates hold and deposit link", async () => {
    const intents = { slot_selection_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {
        lastSentSlots: [
          {
            startTime: "2025-01-01T17:00:00.000Z",
            endTime: "2025-01-01T17:30:00.000Z",
            displayText: "Wed 5:00 PM",
            calendarId: "cal_1",
            artist: "Joan",
          },
        ],
      },
      contact: { id: "contact123" },
      messageText: "option 1",
    });

    expect(parseTimeSelection).toHaveBeenCalled();
    expect(createConsultAppointment).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "contact123",
        calendarId: "cal_1",
        startTime: "2025-01-01T17:00:00.000Z",
      })
    );
    expect(createDepositLinkForContact).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "contact123" })
    );
    expect(updateSystemFields).toHaveBeenCalledWith(
      "contact123",
      expect.objectContaining({
        hold_appointment_id: "apt_123",
        hold_warning_sent: false,
        deposit_link_sent: true,
        deposit_link_url: "https://pay.test/link",
      })
    );
    expect(res.bubbles[0]).toMatch(/Got you for/i);
    expect(res.bubbles[0]).toMatch(/deposit/i);
  });

  test("deposit intent with deposit already paid does not send link", async () => {
    const intents = { deposit_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "qualified",
      canonicalState: {
        depositPaid: true,
        lastSentSlots: [
          {
            startTime: "2025-01-01T17:00:00.000Z",
            endTime: "2025-01-01T17:30:00.000Z",
            displayText: "Wed 5:00 PM",
            calendarId: "cal_1",
            artist: "Joan",
          },
        ],
      },
      contact: { id: "contact123" },
      messageText: "send deposit link",
    });

    expect(res.bubbles[0]).toMatch(/deposit is confirmed/i);
    expect(res.bubbles[0]).not.toContain("http");
  });

  test("reschedule intent with hold cancels and offers new slots", async () => {
    const intents = { reschedule_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {
        holdAppointmentId: "apt_123",
        upcomingAppointmentId: "apt_123",
        lastSentSlots: [
          { startTime: "2025-01-01T17:00:00.000Z", displayText: "Wed 5:00 PM" },
          { startTime: "2025-01-01T18:00:00.000Z", displayText: "Wed 6:00 PM" },
        ],
      },
      contact: { id: "contact123" },
      messageText: "Can we move my appointment?",
    });

    expect(updateAppointmentStatus).toHaveBeenCalledWith("apt_123", "cancelled");
    expect(res.bubbles[0]).toMatch(/openings/i);
    expect(res.bubbles[0]).toMatch(/Which works best/i);
  });

  test("cancel intent with hold cancels and confirms", async () => {
    const intents = { cancel_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {
        holdAppointmentId: "apt_123",
        upcomingAppointmentId: "apt_123",
      },
      contact: { id: "contact123" },
      messageText: "I need to cancel",
    });

    expect(updateAppointmentStatus).toHaveBeenCalledWith("apt_123", "cancelled");
    expect(res.bubbles[0]).toMatch(/canceled/i);
  });

  test("reschedule intent with no appointment falls back to scheduling", async () => {
    const intents = { reschedule_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {},
      contact: { id: "contact123" },
      messageText: "Can we move my appointment?",
    });
    expect(res.bubbles[0]).toMatch(/openings/i);
    expect(res.bubbles[0]).toMatch(/Which works best/i);
  });

  test("reschedule booked consult cancels upcoming appointment id", async () => {
    const intents = { reschedule_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {
        upcomingAppointmentId: "consult_999",
        holdAppointmentId: null,
      },
      contact: { id: "contact123" },
      messageText: "Need to move it",
    });

    expect(updateAppointmentStatus).toHaveBeenCalledWith("consult_999", "cancelled");
    expect(updateSystemFields).toHaveBeenCalledWith(
      "contact123",
      expect.objectContaining({
        consult_appointment_id: null,
        appointment_id: null,
      })
    );
    expect(res.bubbles[0]).toMatch(/openings/i);
  });

  test("cancel booked consult clears consult appointment fields", async () => {
    const intents = { cancel_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {
        upcomingAppointmentId: "consult_888",
        holdAppointmentId: null,
      },
      contact: { id: "contact123" },
      messageText: "Cancel please",
    });

    expect(updateAppointmentStatus).toHaveBeenCalledWith("consult_888", "cancelled");
    expect(updateSystemFields).toHaveBeenCalledWith(
      "contact123",
      expect.objectContaining({
        consult_appointment_id: null,
        appointment_id: null,
      })
    );
    expect(res.bubbles[0]).toMatch(/canceled/i);
  });

  test("translator affirmation sets confirmed and schedules", async () => {
    const intents = { translator_affirm_intent: true, scheduling_intent: true };
    const res = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {
        consultationType: "appointment",
        translatorNeeded: true,
      },
      contact: { id: "contact123" },
      messageText: "Yes that works",
    });

    expect(updateSystemFields).toHaveBeenCalledWith(
      "contact123",
      expect.objectContaining({
        translator_confirmed: true,
        consultation_type_locked: true,
      })
    );
    expect(res.bubbles[0]).toMatch(/openings/i);
    expect(res.bubbles[0]).toMatch(/Which works best/i);
  });
});
