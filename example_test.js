// example_test.js
// End-to-End Objection Library Test with LIVE LLM API
// Run with: node example_test.js
//
// This simulates the full production flow:
// Lead message → Intent Detection → Objection Context Injection → LLM Call → Response

require("dotenv").config();
const { generateOpenerForContact } = require("./src/ai/aiClient");
const { detectIntents } = require("./src/ai/intents");
const { buildCanonicalState } = require("./src/ai/phaseContract");
const { buildContactProfile } = require("./src/ai/contextBuilder");
const { detectObjection, getObjectionIds } = require("./src/prompts/objectionLibrary");

// Simulate a contact with some basic info
const mockContact = {
  id: "test-contact-123",
  firstName: "Sarah",
  lastName: "Johnson",
  phone: "+16125551234",
  email: "sarah@example.com",
  customField: {
    tattoo_summary: "A medium-sized wolf portrait",
    tattoo_placement: "upper arm",
    tattoo_size: "6 inches",
    tattoo_style: "realism",
    how_soon_is_client_deciding: "next month",
    language_preference: "English",
  },
};

// Build canonical state like production does
const canonicalState = buildCanonicalState(mockContact);

// Spanish-speaking contact
const mockContactSpanish = {
  id: "test-contact-456",
  firstName: "María",
  lastName: "García",
  phone: "+16125559876",
  email: "maria@example.com",
  customField: {
    tattoo_summary: "Un retrato de lobo mediano",
    tattoo_placement: "brazo superior",
    tattoo_size: "6 pulgadas",
    tattoo_style: "realismo",
    how_soon_is_client_deciding: "próximo mes",
    language_preference: "Spanish",
  },
};

// Test scenarios - each simulates a lead raising an objection
const testScenarios = [
  {
    name: "Price Objection (English)",
    message: "That's more than I expected. Can you do something cheaper?",
    language: "en",
  },
  {
    name: "Price Objection (Spanish)",
    message: "Está muy caro eso, no tengo tanto dinero ahorita",
    language: "es",
    contact: mockContactSpanish,
    thread: [
      `STUDIO [Dec 20, 2:30 PM]: Hola María — ese retrato de lobo va a quedar increíble en el brazo. ¿Para cuándo lo estás pensando?`,
      `LEAD [Dec 20, 3:15 PM]: Está muy caro eso, no tengo tanto dinero ahorita`,
    ],
  },
  {
    name: "Need to Think",
    message: "Let me think about it and get back to you",
    language: "en",
  },
  {
    name: "Ask Partner",
    message: "I need to ask my husband first before I commit",
    language: "en",
  },
  {
    name: "First Tattoo Fear",
    message: "It's my first tattoo and I'm pretty nervous. Will it hurt a lot?",
    language: "en",
  },
  {
    name: "Design Uncertainty",
    message: "What if I don't like the design after I pay?",
    language: "en",
  },
  {
    name: "Refund Skepticism",
    message: "Is it actually refundable or is that just what you say?",
    language: "en",
  },
  {
    name: "Exact Price Request",
    message: "Can you just tell me how much it will cost before I schedule anything?",
    language: "en",
  },
  {
    name: "Non-Objection (Control)",
    message: "Sounds good! What times do you have available next week?",
    language: "en",
  },
  {
    name: "Need to Think (Spanish)",
    message: "Déjame pensarlo, te aviso después",
    language: "es",
    contact: mockContactSpanish,
    thread: [
      `STUDIO [Dec 20, 2:30 PM]: Hola María — ese retrato de lobo va a quedar increíble. ¿Para cuándo lo estás pensando?`,
      `LEAD [Dec 20, 3:00 PM]: Para el próximo mes más o menos`,
      `STUDIO [Dec 20, 3:05 PM]: Perfecto, eso funciona. El siguiente paso es una consulta rápida de 15-20 minutos con el artista.`,
      `LEAD [Dec 20, 3:15 PM]: Déjame pensarlo, te aviso después`,
    ],
  },
  {
    name: "First Tattoo Fear (Spanish)",
    message: "Es mi primer tatuaje y tengo miedo, ¿duele mucho?",
    language: "es",
    contact: mockContactSpanish,
    thread: [
      `STUDIO [Dec 20, 2:30 PM]: Hola María — ese diseño va a quedar increíble.`,
      `LEAD [Dec 20, 3:15 PM]: Es mi primer tatuaje y tengo miedo, ¿duele mucho?`,
    ],
  },
];

async function runTest(scenario) {
  console.log("\n" + "=".repeat(70));
  console.log(`🧪 TEST: ${scenario.name}`);
  console.log("=".repeat(70));
  
  const contact = scenario.contact || mockContact;
  const messageText = scenario.message;
  
  // Build conversation thread
  const defaultThread = [
    `STUDIO [Dec 20, 2:30 PM]: Hey ${contact.firstName} — that wolf portrait is gonna look sick on the upper arm. When were you thinking of getting it done?`,
    `LEAD [Dec 20, 3:15 PM]: ${messageText}`,
  ];
  const thread = scenario.thread || defaultThread;
  
  console.log(`\n📱 CONVERSATION THREAD:`);
  console.log("-".repeat(50));
  thread.forEach(msg => {
    const isLead = msg.startsWith("LEAD");
    const prefix = isLead ? "  👤" : "  🏪";
    console.log(`${prefix} ${msg}`);
  });
  console.log("-".repeat(50));
  
  console.log(`\n💬 LATEST MESSAGE: "${messageText}"\n`);
  
  // Step 1: Detect intents (including objection detection)
  const intents = detectIntents(messageText, canonicalState);
  
  console.log("📊 INTENT DETECTION:");
  console.log(`   objection_intent: ${intents.objection_intent}`);
  console.log(`   objection_type: ${intents.objection_type || "(none)"}`);
  
  if (intents.objection_data) {
    console.log(`   category: ${intents.objection_data.category}`);
    console.log(`   belief_to_fix: ${intents.objection_data.belief_to_fix}`);
    console.log(`   core_reframe: ${intents.objection_data.core_reframe}`);
  }
  
  // Step 2: Build contact profile
  const contactProfile = buildContactProfile(canonicalState, {
    changedFields: {},
    derivedPhase: intents.objection_intent ? "objections" : "discovery",
    intents,
  });
  
  // Step 3: Call the LLM with objection context injected
  console.log("\n🤖 CALLING LLM...\n");
  
  const startTime = Date.now();
  
  try {
    // Build canonical state for this specific contact
    const contactCanonicalState = buildCanonicalState(contact);
    
    const response = await generateOpenerForContact({
      contact,
      canonicalState: contactCanonicalState,
      aiPhase: intents.objection_intent ? "objections" : "discovery",
      leadTemperature: "warm",
      latestMessageText: messageText,
      contactProfile,
      consultExplained: false,
      conversationThread: {
        thread: thread,
        summary: null,
        totalCount: thread.length,
      },
      detectedObjection: intents.objection_data || null,
    });
    
    const duration = Date.now() - startTime;
    
    console.log("✅ AI RESPONSE:");
    console.log("-".repeat(50));
    
    if (response.bubbles && response.bubbles.length > 0) {
      response.bubbles.forEach((bubble, i) => {
        console.log(`\n   [Bubble ${i + 1}]:`);
        console.log(`   ${bubble}`);
      });
    }
    
    console.log("\n" + "-".repeat(50));
    console.log("\n📈 RESPONSE META:");
    console.log(`   language: ${response.language}`);
    console.log(`   aiPhase: ${response.meta?.aiPhase}`);
    console.log(`   leadTemperature: ${response.meta?.leadTemperature}`);
    
    if (response.meta?.objectionType) {
      console.log(`   objectionType: ${response.meta.objectionType}`);
      console.log(`   objectionHandled: ${response.meta.objectionHandled}`);
    }
    
    console.log(`   wantsDepositLink: ${response.meta?.wantsDepositLink}`);
    console.log(`   wantsAppointmentOffer: ${response.meta?.wantsAppointmentOffer}`);
    
    console.log(`\n⏱️  Response time: ${duration}ms`);
    
    // Verify objection handling rules
    if (intents.objection_intent) {
      console.log("\n🔍 OBJECTION RULE VERIFICATION:");
      const fullResponse = response.bubbles.join(" ").toLowerCase();
      
      const hasTimeChoice = fullResponse.includes("time") || 
                           fullResponse.includes("work") ||
                           fullResponse.includes("prefer") ||
                           fullResponse.includes("cuál");
      const mentionsDeposit = fullResponse.includes("deposit") || 
                             fullResponse.includes("$100") ||
                             fullResponse.includes("depósito");
      const mentionsRefundable = fullResponse.includes("refund") || 
                                fullResponse.includes("reembols");
      
      console.log(`   ✓ Ends with time choice: ${hasTimeChoice ? "YES ✅" : "NO ⚠️"}`);
      console.log(`   ✓ Mentions deposit: ${mentionsDeposit ? "YES ✅" : "NO ⚠️"}`);
      console.log(`   ✓ Mentions refundable: ${mentionsRefundable ? "YES ✅" : "NO ⚠️"}`);
    }
    
    return { success: true, response };
    
  } catch (error) {
    console.log("❌ ERROR:", error.message);
    return { success: false, error };
  }
}

async function main() {
  console.log("\n" + "█".repeat(70));
  console.log("   AI SETTER OBJECTION LIBRARY - END-TO-END LIVE TEST");
  console.log("█".repeat(70));
  
  console.log("\n📋 Available objection types:", getObjectionIds().join(", "));
  console.log("\n🔑 Using LLM API for real responses\n");
  
  // Check if API key is set
  if (!process.env.LLM_API_KEY) {
    console.log("❌ ERROR: LLM_API_KEY not found in environment.");
    console.log("   Make sure your .env file has LLM_API_KEY set.");
    process.exit(1);
  }
  
  console.log("✅ API key found, starting tests...\n");
  
  const results = [];
  
  for (const scenario of testScenarios) {
    const result = await runTest(scenario);
    results.push({ scenario: scenario.name, ...result });
    
    // Small delay between API calls
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Summary
  console.log("\n" + "█".repeat(70));
  console.log("   TEST SUMMARY");
  console.log("█".repeat(70) + "\n");
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  results.forEach(r => {
    const status = r.success ? "✅" : "❌";
    console.log(`${status} ${r.scenario}`);
  });
  
  console.log(`\n📊 Total: ${successful} passed, ${failed} failed`);
  console.log("\n" + "█".repeat(70) + "\n");
}

main().catch(console.error);

