// multi_intent_routing.test.js
// Verify multi-intent routing: consult path choice + scheduling

jest.mock("../ghlClient", () => ({
  updateSystemFields: jest.fn(async () => ({})),
  sendConversationMessage: jest.fn(async () => ({})),
  getContact: jest.fn(async () => ({ id: "contact123" })),
}));

jest.mock("../src/clients/ghlOpportunityClient", () => ({
  searchOpportunities: jest.fn(async () => []),
}));

jest.mock("../src/ai/bookingController", () => ({
  isTimeSelection: jest.fn(() => false),
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
    const ampm = hour >= 12 ? "pm" : "am";
    const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    return `${dayName}, ${month} ${day} at ${displayHour}${ampm}`;
  }),
  getAvailableSlots: jest.fn(async () => [
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
}));

const { detectIntents } = require("../src/ai/intents");
const { handlePathChoice } = require("../src/ai/consultPathHandler");
const { shouldHardSkipAI } = require("../src/ai/hardSkip");
const { buildDeterministicResponse } = require("../src/ai/deterministicResponses");
const { updateSystemFields } = require("../src/clients/ghlClient");

describe("Multi-intent routing: 'Video call this week—what times?'", () => {
  test("updates consult choice and returns slots", async () => {
    const messageText = "Video call this week—what times?";
    const contact = { id: "contact123" };
    
    console.log("\n" + "=".repeat(80));
    console.log("ROUTING VERIFICATION: Multi-intent (consult + scheduling)");
    console.log("=".repeat(80));
    
    // Step 1: Detect intents
    const intents = detectIntents(messageText);
    console.log(`\n📨 [INBOUND] Message: "${messageText}"`);
    console.log(`🔍 [INTENT] Detected intents:`, JSON.stringify(intents, null, 2));
    
    // Verify both intents are detected
    expect(intents.consult_path_choice_intent).toBe(true);
    expect(intents.scheduling_intent).toBe(true);
    
    // Step 2: Apply consult path choice (side effect)
    const canonicalState = {
      consultationType: null,
      consultationTypeLocked: false,
    };
    
    console.log(`\n📝 [CONSULTATION_TYPE] Applying consult path choice (applyOnly=true)...`);
    
    await handlePathChoice({
      contactId: contact.id,
      messageText,
      channelContext: {},
      sendConversationMessage: null, // Not called in applyOnly mode
      existingConsultType: canonicalState.consultationType,
      consultationTypeLocked: canonicalState.consultationTypeLocked,
      applyOnly: true,
    });
    
    // Verify consult type was updated
    expect(updateSystemFields).toHaveBeenCalled();
    const updateCalls = updateSystemFields.mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1];
    
    console.log(`✅ [CONSULTATION_TYPE] Updated fields:`, lastCall[1]);
    
    expect(lastCall[1]).toMatchObject({
      consultation_type: "appointment",
      consultation_type_locked: true,
      translator_needed: true,
    });
    
    // Step 3: Check routing decision
    const hardSkip = shouldHardSkipAI({
      intents,
      derivedPhase: "scheduling",
      canonicalState,
    });
    
    console.log(`\n🧭 [ROUTING] Hard skip decision:`, hardSkip);
    
    expect(hardSkip.skip).toBe(true);
    expect(hardSkip.reason).toBe("scheduling_intent");
    
    const selectedHandler = hardSkip.skip ? "deterministic" : "ai";
    console.log(`🧭 [ROUTING] Handler selected: ${selectedHandler}`);
    
    // Step 4: Build deterministic scheduling response
    console.log(`\n📅 [SCHEDULING] Generating slots...`);
    
    const response = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {
        ...canonicalState,
        consultationType: "appointment", // Updated by handlePathChoice
        consultationTypeLocked: true,
      },
      contact,
    });
    
    console.log(`\n📝 [RESPONSE] Generated response:`);
    console.log(`   Bubbles:`, response.bubbles);
    console.log(`   Internal notes: ${response.internal_notes}`);
    
    // Verify response includes slots
    expect(response.bubbles).toHaveLength(1);
    expect(response.bubbles[0]).toMatch(/I pulled a few openings/i);
    expect(response.bubbles[0]).toMatch(/1\)/);
    expect(response.bubbles[0]).toMatch(/2\)/);
    expect(response.bubbles[0]).toMatch(/3\)/);
    expect(response.bubbles[0]).toMatch(/Which works best\?/i);
    expect(response.internal_notes).toBe("deterministic_scheduling_slots");
    
    console.log("\n✅ Verification complete:");
    console.log(`   ✓ Consult type updated: appointment (translator needed)`);
    console.log(`   ✓ Handler: ${selectedHandler}`);
    console.log(`   ✓ Response includes ${response.bubbles[0].match(/\d\)/g)?.length || 0} slot options`);
    console.log("=".repeat(80));
  });
  
  test("shows complete routing log output", async () => {
    const messageText = "Video call this week—what times?";
    const contact = { id: "contact123" };
    
    console.log("\n" + "=".repeat(80));
    console.log("COMPLETE ROUTING LOG FOR: 'Video call this week—what times?'");
    console.log("=".repeat(80));
    
    const intents = detectIntents(messageText);
    console.log(`\n📨 [INBOUND] Message received: "${messageText}"`);
    console.log(`🔍 [INTENT] Detected intents:`, JSON.stringify(intents, null, 2));
    
    // Multi-intent handling
    if (intents.scheduling_intent && intents.consult_path_choice_intent) {
      console.log(`\n🔄 [MULTI-INTENT] Detected consult-path + scheduling`);
      console.log(`📝 [CONSULTATION_TYPE] Applying consult-path updates (applyOnly=true)...`);
      
      await handlePathChoice({
        contactId: contact.id,
        messageText,
        channelContext: {},
        sendConversationMessage: null,
        existingConsultType: null,
        consultationTypeLocked: false,
        applyOnly: true,
      });
      
      console.log(`✅ [ROUTING] Consult-path updates applied before scheduling`);
    }
    
    const hardSkip = shouldHardSkipAI({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {},
    });
    
    const selectedHandler = hardSkip.skip ? "deterministic" : "ai";
    console.log(`\n🧭 [ROUTING] Handler selected: ${selectedHandler}`);
    console.log(`💡 [ROUTING] Reason: ${hardSkip.reason}`);
    
    if (hardSkip.skip) {
      const response = await buildDeterministicResponse({
        intents,
        derivedPhase: "scheduling",
        canonicalState: {
          consultationType: "appointment",
          consultationTypeLocked: true,
        },
        contact,
      });
      
      console.log(`\n📝 [DETERMINISTIC] Scheduling response:`);
      console.log(`   Message: "${response.bubbles[0].substring(0, 100)}..."`);
      console.log(`   Internal notes: ${response.internal_notes}`);
      console.log(`   Meta:`, JSON.stringify(response.meta, null, 2));
    }
    
    console.log("\n" + "=".repeat(80));
    
    expect(selectedHandler).toBe("deterministic");
    expect(intents.consult_path_choice_intent).toBe(true);
    expect(intents.scheduling_intent).toBe(true);
  });
});
