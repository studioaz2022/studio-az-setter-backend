// hold_lifecycle_verification.test.js
// Verify hold lifecycle: one warning at 10min, one release at 20min

jest.mock("../ghlClient", () => ({
  updateSystemFields: jest.fn(async () => ({})),
  sendConversationMessage: jest.fn(async () => ({})),
}));

jest.mock("../src/clients/ghlCalendarClient", () => ({
  updateAppointmentStatus: jest.fn(async () => ({})),
}));

const { evaluateHoldState } = require("../src/ai/holdLifecycle");
const { updateSystemFields, sendConversationMessage } = require("../ghlClient");
const { updateAppointmentStatus } = require("../src/clients/ghlCalendarClient");

describe("Hold Lifecycle Verification: Warning + Release", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("sends one warning at 10 minutes, one release at 20 minutes", async () => {
    const contact = { id: "contact123", phone: "555-1234" };
    const holdCreatedAt = new Date("2024-12-20T10:00:00Z");
    const holdId = "apt_hold_123";

    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION: Hold Lifecycle (Warning + Release)");
    console.log("=".repeat(80));

    // Initial state: Hold just created
    let canonicalState = {
      holdAppointmentId: holdId,
      holdLastActivityAt: holdCreatedAt.toISOString(),
      holdWarningSent: false,
      depositPaid: false,
    };

    console.log(`\n📅 [INITIAL] Hold created at: ${holdCreatedAt.toISOString()}`);
    console.log(`   Hold ID: ${holdId}`);

    // Test 1: At 5 minutes - no action
    const fiveMinutesLater = new Date(holdCreatedAt.getTime() + 5 * 60 * 1000);
    console.log(`\n⏰ [5 MINUTES] Checking hold state...`);
    
    let result = await evaluateHoldState({
      contact,
      canonicalState,
      now: fiveMinutesLater,
    });

    console.log(`   Result: warned=${result.warned}, released=${result.released}`);
    expect(result.warned).toBe(false);
    expect(result.released).toBe(false);
    expect(sendConversationMessage).not.toHaveBeenCalled();
    expect(updateAppointmentStatus).not.toHaveBeenCalled();

    // Test 2: At 10 minutes - warning should be sent
    const tenMinutesLater = new Date(holdCreatedAt.getTime() + 10 * 60 * 1000);
    console.log(`\n⏰ [10 MINUTES] Checking hold state (warning threshold)...`);

    result = await evaluateHoldState({
      contact,
      canonicalState,
      now: tenMinutesLater,
    });

    console.log(`   Result: warned=${result.warned}, released=${result.released}`);
    expect(result.warned).toBe(true);
    expect(result.released).toBe(false);

    // Verify warning message sent exactly once
    expect(sendConversationMessage).toHaveBeenCalledTimes(1);
    const warningCall = sendConversationMessage.mock.calls[0];
    expect(warningCall[0].body).toContain("still holding");
    expect(warningCall[0].body).toContain("release it soon");
    console.log(`   ✓ Warning message sent: "${warningCall[0].body}"`);

    // Verify hold_warning_sent flag updated
    expect(updateSystemFields).toHaveBeenCalledWith(
      "contact123",
      expect.objectContaining({
        hold_warning_sent: true,
      })
    );
    console.log(`   ✓ hold_warning_sent flag set to true`);

    // Update canonical state to reflect warning sent
    canonicalState.holdWarningSent = true;

    // Test 3: At 15 minutes - no new warning (already sent)
    const fifteenMinutesLater = new Date(holdCreatedAt.getTime() + 15 * 60 * 1000);
    console.log(`\n⏰ [15 MINUTES] Checking hold state (warning already sent)...`);

    jest.clearAllMocks(); // Clear previous calls

    result = await evaluateHoldState({
      contact,
      canonicalState,
      now: fifteenMinutesLater,
    });

    console.log(`   Result: warned=${result.warned}, released=${result.released}`);
    expect(result.warned).toBe(false); // Warning already sent
    expect(result.released).toBe(false);
    expect(sendConversationMessage).not.toHaveBeenCalled(); // No duplicate warning

    // Test 4: At 20 minutes - release should happen
    const twentyMinutesLater = new Date(holdCreatedAt.getTime() + 20 * 60 * 1000);
    console.log(`\n⏰ [20 MINUTES] Checking hold state (release threshold)...`);

    result = await evaluateHoldState({
      contact,
      canonicalState,
      now: twentyMinutesLater,
    });

    console.log(`   Result: warned=${result.warned}, released=${result.released}`);
    expect(result.released).toBe(true);
    expect(result.warned).toBe(false);

    // Verify appointment cancelled exactly once
    expect(updateAppointmentStatus).toHaveBeenCalledTimes(1);
    const cancelCall = updateAppointmentStatus.mock.calls[0];
    expect(cancelCall[0]).toBe(holdId);
    expect(cancelCall[1]).toBe("cancelled");
    console.log(`   ✓ Appointment cancelled: ${holdId}`);

    // Verify release message sent exactly once
    expect(sendConversationMessage).toHaveBeenCalledTimes(1);
    const releaseCall = sendConversationMessage.mock.calls[0];
    expect(releaseCall[0].body).toContain("released");
    expect(releaseCall[0].body).toContain("next best slot");
    console.log(`   ✓ Release message sent: "${releaseCall[0].body}"`);

    // Verify hold fields cleared
    expect(updateSystemFields).toHaveBeenCalledWith(
      "contact123",
      expect.objectContaining({
        hold_appointment_id: null,
        hold_created_at: null,
        hold_last_activity_at: null,
        hold_warning_sent: false,
        last_sent_slots: null,
      })
    );
    console.log(`   ✓ Hold fields cleared`);

    console.log(`\n✅ Verification complete:`);
    console.log(`   ✓ Warning sent: 1 time (at 10 minutes)`);
    console.log(`   ✓ Release executed: 1 time (at 20 minutes)`);
    console.log(`   ✓ No duplicate warnings or releases`);
    console.log("=".repeat(80));
  });

  test("prevents duplicate warnings when warning already sent", async () => {
    const contact = { id: "contact123" };
    const holdCreatedAt = new Date("2024-12-20T10:00:00Z");
    const holdId = "apt_hold_123";

    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION: Duplicate Warning Prevention");
    console.log("=".repeat(80));

    const canonicalState = {
      holdAppointmentId: holdId,
      holdLastActivityAt: holdCreatedAt.toISOString(),
      holdWarningSent: true, // Warning already sent
      depositPaid: false,
    };

    console.log(`\n📊 [STATE] hold_warning_sent: ${canonicalState.holdWarningSent}`);

    // At 12 minutes (past warning threshold, but warning already sent)
    const twelveMinutesLater = new Date(holdCreatedAt.getTime() + 12 * 60 * 1000);
    console.log(`\n⏰ [12 MINUTES] Checking hold state (warning already sent)...`);

    const result = await evaluateHoldState({
      contact,
      canonicalState,
      now: twelveMinutesLater,
    });

    console.log(`   Result: warned=${result.warned}, released=${result.released}`);

    // Should NOT send another warning
    expect(result.warned).toBe(false);
    expect(sendConversationMessage).not.toHaveBeenCalled();
    expect(updateAppointmentStatus).not.toHaveBeenCalled();

    console.log(`   ✓ No duplicate warning sent`);
    console.log("=".repeat(80));
  });

  test("skips warning and release when deposit is paid", async () => {
    const contact = { id: "contact123" };
    const holdCreatedAt = new Date("2024-12-20T10:00:00Z");
    const holdId = "apt_hold_123";

    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION: Deposit Paid - No Warning/Release");
    console.log("=".repeat(80));

    const canonicalState = {
      holdAppointmentId: holdId,
      holdLastActivityAt: holdCreatedAt.toISOString(),
      holdWarningSent: false,
      depositPaid: true, // Deposit paid - should skip all hold processing
    };

    console.log(`\n💰 [STATE] Deposit paid: ${canonicalState.depositPaid}`);

    // At 25 minutes (past both thresholds)
    const twentyFiveMinutesLater = new Date(holdCreatedAt.getTime() + 25 * 60 * 1000);
    console.log(`\n⏰ [25 MINUTES] Checking hold state (deposit paid)...`);

    const result = await evaluateHoldState({
      contact,
      canonicalState,
      now: twentyFiveMinutesLater,
    });

    console.log(`   Result: warned=${result.warned}, released=${result.released}`);

    // Should skip all processing when deposit is paid
    expect(result.warned).toBe(false);
    expect(result.released).toBe(false);
    expect(sendConversationMessage).not.toHaveBeenCalled();
    expect(updateAppointmentStatus).not.toHaveBeenCalled();

    console.log(`   ✓ No warning or release (deposit paid)`);
    console.log("=".repeat(80));
  });

  test("shows complete lifecycle timeline simulation", async () => {
    const contact = { id: "contact123", phone: "555-1234" };
    const holdCreatedAt = new Date("2024-12-20T10:00:00Z");
    const holdId = "apt_hold_123";

    console.log("\n" + "=".repeat(80));
    console.log("COMPLETE LIFECYCLE TIMELINE SIMULATION");
    console.log("=".repeat(80));

    let canonicalState = {
      holdAppointmentId: holdId,
      holdLastActivityAt: holdCreatedAt.toISOString(),
      holdWarningSent: false,
      depositPaid: false,
    };

    const timeline = [
      { minutes: 0, label: "Hold created" },
      { minutes: 5, label: "5 minutes elapsed" },
      { minutes: 10, label: "10 minutes - Warning threshold" },
      { minutes: 12, label: "12 minutes - After warning" },
      { minutes: 15, label: "15 minutes - Mid-hold" },
      { minutes: 20, label: "20 minutes - Release threshold" },
      { minutes: 25, label: "25 minutes - After release" },
    ];

    let warningCount = 0;
    let releaseCount = 0;

    for (const point of timeline) {
      const now = new Date(holdCreatedAt.getTime() + point.minutes * 60 * 1000);
      jest.clearAllMocks();

      const result = await evaluateHoldState({
        contact,
        canonicalState,
        now,
      });

      if (result.warned) {
        warningCount++;
        canonicalState.holdWarningSent = true;
        console.log(`\n⏰ [${point.minutes} MIN] ${point.label}`);
        console.log(`   Action: WARNING SENT`);
        console.log(`   Total warnings: ${warningCount}`);
      } else if (result.released) {
        releaseCount++;
        console.log(`\n⏰ [${point.minutes} MIN] ${point.label}`);
        console.log(`   Action: RELEASE EXECUTED`);
        console.log(`   Total releases: ${releaseCount}`);
        break; // Hold is released, no more processing
      } else {
        console.log(`\n⏰ [${point.minutes} MIN] ${point.label}`);
        console.log(`   Action: No action`);
      }
    }

    console.log(`\n✅ Lifecycle Summary:`);
    console.log(`   Total warnings sent: ${warningCount}`);
    console.log(`   Total releases executed: ${releaseCount}`);
    console.log(`   Expected: 1 warning, 1 release`);
    console.log("=".repeat(80));

    expect(warningCount).toBe(1);
    expect(releaseCount).toBe(1);
  });
});

