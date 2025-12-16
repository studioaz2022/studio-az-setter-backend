// routing_verification.test.js
// Verify routing decisions for specific messages

jest.mock("../ghlClient", () => ({
  updateSystemFields: jest.fn(async () => ({})),
}));

const { detectIntents } = require("../src/ai/intents");
const { shouldHardSkipAI } = require("../src/ai/hardSkip");
const { buildDeterministicResponse } = require("../src/ai/deterministicResponses");

describe("Routing Verification: 'what times this week?'", () => {
  test("routes to deterministic scheduling response when scheduling intent detected", async () => {
    const messageText = "what times this week?";
    
    // Step 1: Detect intents
    const intents = detectIntents(messageText);
    console.log("🔍 Detected intents:", intents);
    
    // Verify scheduling intent is detected
    expect(intents.scheduling_intent).toBe(true);
    
    // Step 2: Check if should skip AI
    const hardSkip = shouldHardSkipAI({
      intents,
      derivedPhase: null,
      canonicalState: {},
    });
    
    console.log("⏭️ Hard skip decision:", hardSkip);
    
    // Verify AI is skipped
    expect(hardSkip.skip).toBe(true);
    expect(hardSkip.reason).toBe("scheduling_intent");
    
    // Step 3: Build deterministic response
    const deterministicResponse = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState: {},
      contact: { id: "contact123" },
    });
    
    console.log("📝 Deterministic response:", deterministicResponse);
    
    // Verify scheduling response includes multiple options and question
    expect(deterministicResponse.bubbles[0]).toMatch(/Which works best\?/i);
    expect(deterministicResponse.bubbles[0]).toMatch(/1\)/);
    
    // Step 4: Verify routing decision
    const selectedHandler = hardSkip.skip ? "deterministic" : "ai";
    expect(selectedHandler).toBe("deterministic");
    
    console.log("✅ Routing verification complete:");
    console.log(`   Handler: ${selectedHandler}`);
    console.log(`   Reason: ${hardSkip.reason}`);
    console.log(`   Response: "${deterministicResponse.bubbles[0]}"`);
  });
  
  test("shows complete routing log output", async () => {
    const messageText = "what times this week?";
    
    console.log("\n" + "=".repeat(80));
    console.log("ROUTING DECISION LOG FOR: 'what times this week?'");
    console.log("=".repeat(80));
    
    const intents = detectIntents(messageText);
    console.log(`\n📨 [INBOUND] Message received: "${messageText}"`);
    console.log(`🔍 [INTENT] Detected intents:`, JSON.stringify(intents, null, 2));
    
    const hardSkip = shouldHardSkipAI({ intents, derivedPhase: null, canonicalState: {} });
    const selectedHandler = hardSkip.skip ? "deterministic" : "ai";
    
    console.log(`\n🧭 [ROUTING] Handler selected: ${selectedHandler}`);
    console.log(`💡 [ROUTING] Reason: ${hardSkip.reason || "none"}`);
    
    if (hardSkip.skip) {
      const response = await buildDeterministicResponse({
        intents,
        derivedPhase: "scheduling",
        canonicalState: {},
        contact: { id: "contact123" },
      });
      console.log(`\n📝 [DETERMINISTIC] Scheduling response generated:`);
      console.log(`   Bubbles: ${JSON.stringify(response.bubbles)}`);
      console.log(`   Internal notes: ${response.internal_notes}`);
      console.log(`   Meta: ${JSON.stringify(response.meta)}`);
    }
    
    console.log("\n" + "=".repeat(80));
    
    expect(selectedHandler).toBe("deterministic");
    expect(hardSkip.reason).toBe("scheduling_intent");
  });
});

