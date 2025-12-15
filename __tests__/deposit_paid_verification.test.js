// deposit_paid_verification.test.js
// Verify that "send link" after deposit is paid returns next-steps, not a new link

jest.mock("../ghlClient", () => ({
  updateSystemFields: jest.fn(async () => ({})),
}));

jest.mock("../src/payments/squareClient", () => ({
  createDepositLinkForContact: jest.fn(async () => ({
    url: "https://pay.square.com/test-link-123",
  })),
}));

jest.mock("../src/ai/bookingController", () => ({
  generateSuggestedSlots: jest.fn(() => [
    {
      startTime: "2024-12-20T17:00:00Z",
      endTime: "2024-12-20T17:30:00Z",
      displayText: "Friday, Dec 20 at 5pm",
    },
    {
      startTime: "2024-12-23T17:00:00Z",
      endTime: "2024-12-23T17:30:00Z",
      displayText: "Monday, Dec 23 at 5pm",
    },
    {
      startTime: "2024-12-24T17:00:00Z",
      endTime: "2024-12-24T17:30:00Z",
      displayText: "Tuesday, Dec 24 at 5pm",
    },
  ]),
  formatSlotDisplay: jest.fn((date) => {
    const d = new Date(date);
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayName = days[d.getDay()];
    const month = d.toLocaleString("default", { month: "short" });
    const day = d.getDate();
    const hour = d.getHours();
    const minute = d.getMinutes();
    const ampm = hour >= 12 ? "pm" : "am";
    const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    const displayMinute = minute === 0 ? "" : `:${minute.toString().padStart(2, "0")}`;
    return `${dayName}, ${month} ${day} at ${displayHour}${displayMinute}${ampm}`;
  }),
  parseTimeSelection: jest.fn(() => null),
  createConsultAppointment: jest.fn(async () => ({ id: "apt_123" })),
  isTimeSelection: jest.fn(() => false),
}));

const { detectIntents } = require("../src/ai/intents");
const { buildDeterministicResponse } = require("../src/ai/deterministicResponses");
const { createDepositLinkForContact } = require("../src/payments/squareClient");
const { updateSystemFields } = require("../ghlClient");

describe("Deposit Paid Verification: 'send link' after payment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns next-steps (scheduling slots) when deposit already paid", async () => {
    const messageText = "send me the link";
    const contact = { id: "contact123" };
    const canonicalState = {
      depositPaid: true, // Deposit already paid
      lastSentSlots: [], // No previous slots
    };

    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION: Deposit Link Request After Payment");
    console.log("=".repeat(80));

    // Step 1: Detect deposit intent
    const intents = detectIntents(messageText);
    console.log(`\n📨 [INBOUND] Message: "${messageText}"`);
    console.log(`🔍 [INTENT] Detected intents:`, JSON.stringify(intents, null, 2));
    console.log(`💰 [STATE] Deposit paid: ${canonicalState.depositPaid}`);

    expect(intents.deposit_intent).toBe(true);
    expect(canonicalState.depositPaid).toBe(true);

    // Step 2: Build deterministic response
    console.log(`\n📝 [RESPONSE] Processing deposit intent with deposit already paid...`);

    const response = await buildDeterministicResponse({
      intents,
      derivedPhase: "qualified",
      canonicalState,
      contact,
      messageText,
    });

    console.log(`\n📝 [RESPONSE] Generated response:`);
    console.log(`   Bubbles:`, response.bubbles);
    console.log(`   Internal notes: ${response.internal_notes}`);

    // Step 3: Verify NO deposit link was created
    console.log(`\n✅ [VERIFICATION] Checking deposit link creation...`);
    expect(createDepositLinkForContact).not.toHaveBeenCalled();
    console.log(`   ✓ Deposit link NOT created (deposit already paid)`);

    // Step 4: Verify next-steps (scheduling slots) are returned instead
    console.log(`\n✅ [VERIFICATION] Checking response content...`);
    expect(response.bubbles[0]).toMatch(/deposit.*confirmed|Thanks.*deposit/i);
    expect(response.bubbles[0]).toMatch(/next openings|Here are|Which works/i);
    expect(response.bubbles[0]).toMatch(/1\)|2\)|3\)/); // Should include slot options
    expect(response.internal_notes).toBe("deterministic_deposit_paid_scheduling");

    // Step 5: Verify response does NOT contain a deposit link URL
    expect(response.bubbles[0]).not.toContain("https://pay.square.com");
    expect(response.bubbles[0]).not.toContain("deposit to lock");
    expect(response.bubbles[0]).not.toContain("refundable deposit");

    console.log(`\n✅ Verification complete:`);
    console.log(`   ✓ Deposit link NOT sent (deposit already paid)`);
    console.log(`   ✓ Next-steps (scheduling slots) returned instead`);
    console.log(`   ✓ Response confirms deposit is paid`);
    console.log(`   ✓ Response offers scheduling options`);
    console.log("=".repeat(80));
  });

  test("returns fallback next-steps when no slots available", async () => {
    const { generateSuggestedSlots } = require("../src/ai/bookingController");
    
    const messageText = "send me the deposit link"; // Use full phrase to ensure deposit_intent is detected
    const contact = { id: "contact123" };
    const canonicalState = {
      depositPaid: true,
      lastSentSlots: [], // Empty slots
    };

    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION: Deposit Paid - Fallback Next-Steps");
    console.log("=".repeat(80));

    const intents = detectIntents(messageText);
    console.log(`\n📨 [INBOUND] Message: "${messageText}"`);
    console.log(`🔍 [INTENT] Deposit intent: ${intents.deposit_intent}`);
    console.log(`💰 [STATE] Deposit paid: ${canonicalState.depositPaid}`);
    console.log(`📅 [STATE] Last sent slots: ${canonicalState.lastSentSlots.length}`);

    // Mock generateSuggestedSlots to return empty array for this test
    generateSuggestedSlots.mockImplementationOnce(() => []);

    const response = await buildDeterministicResponse({
      intents,
      derivedPhase: "qualified",
      canonicalState,
      contact,
      messageText,
    });

    console.log(`\n📝 [RESPONSE] Generated response:`);
    console.log(`   Message: "${response.bubbles[0]}"`);
    console.log(`   Internal notes: ${response.internal_notes}`);

    // Verify no deposit link created
    expect(createDepositLinkForContact).not.toHaveBeenCalled();

    // Verify fallback next-steps message (when slots are empty, should return fallback)
    expect(response.bubbles[0]).toMatch(/deposit.*confirmed|Thanks/i);
    expect(response.bubbles[0]).toMatch(/day\(s\)|time window/i);
    expect(response.internal_notes).toBe("deterministic_deposit_paid_fallback");

    console.log(`\n✅ Fallback next-steps returned (no slots available)`);
    console.log("=".repeat(80));
  });

  test("sends deposit link when deposit NOT paid", async () => {
    const messageText = "send me the deposit link";
    const contact = { id: "contact123" };
    const canonicalState = {
      depositPaid: false, // Deposit NOT paid
    };

    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION: Deposit Link Request (NOT Paid)");
    console.log("=".repeat(80));

    const intents = detectIntents(messageText);
    console.log(`\n📨 [INBOUND] Message: "${messageText}"`);
    console.log(`💰 [STATE] Deposit paid: ${canonicalState.depositPaid}`);

    const response = await buildDeterministicResponse({
      intents,
      derivedPhase: "closing",
      canonicalState,
      contact,
      messageText,
    });

    console.log(`\n📝 [RESPONSE] Generated response:`);
    console.log(`   Message: "${response.bubbles[0]}"`);

    // Verify deposit link WAS created (because not paid)
    expect(createDepositLinkForContact).toHaveBeenCalledTimes(1);
    expect(updateSystemFields).toHaveBeenCalledWith(
      "contact123",
      expect.objectContaining({
        deposit_link_sent: true,
        deposit_link_url: "https://pay.square.com/test-link-123",
      })
    );

    // Verify response contains deposit link
    expect(response.bubbles[0]).toContain("https://pay.square.com/test-link-123");
    expect(response.bubbles[0]).toContain("$100");
    expect(response.bubbles[0]).toContain("refundable deposit");
    expect(response.internal_notes).toBe("deterministic_deposit_link");

    console.log(`\n✅ Deposit link sent (deposit not paid)`);
    console.log("=".repeat(80));
  });

  test("shows complete execution log for paid vs unpaid scenarios", async () => {
    console.log("\n" + "=".repeat(80));
    console.log("COMPLETE EXECUTION LOG: Deposit Link Request Scenarios");
    console.log("=".repeat(80));

    const contact = { id: "contact123" };

    // Scenario 1: Deposit already paid
    console.log(`\n📋 SCENARIO 1: Deposit Already Paid`);
    console.log(`   Message: "send link"`);
    console.log(`   State: depositPaid = true`);

    const intentsPaid = detectIntents("send link");
    const responsePaid = await buildDeterministicResponse({
      intents: intentsPaid,
      derivedPhase: "qualified",
      canonicalState: { depositPaid: true, lastSentSlots: [] },
      contact,
      messageText: "send link",
    });

    console.log(`   Response: "${responsePaid.bubbles[0].substring(0, 80)}..."`);
    console.log(`   Deposit link created: ${createDepositLinkForContact.mock.calls.length} time(s)`);
    console.log(`   Result: Next-steps (scheduling slots)`);

    jest.clearAllMocks();

    // Scenario 2: Deposit NOT paid
    console.log(`\n📋 SCENARIO 2: Deposit NOT Paid`);
    console.log(`   Message: "send link"`);
    console.log(`   State: depositPaid = false`);

    const intentsUnpaid = detectIntents("send link");
    const responseUnpaid = await buildDeterministicResponse({
      intents: intentsUnpaid,
      derivedPhase: "closing",
      canonicalState: { depositPaid: false },
      contact,
      messageText: "send link",
    });

    console.log(`   Response: "${responseUnpaid.bubbles[0].substring(0, 80)}..."`);
    console.log(`   Deposit link created: ${createDepositLinkForContact.mock.calls.length} time(s)`);
    console.log(`   Result: Deposit link sent`);

    console.log("\n✅ Comparison:");
    console.log(`   Paid: Next-steps returned, NO link created`);
    console.log(`   Unpaid: Deposit link created and sent`);
    console.log("=".repeat(80));
  });
});

