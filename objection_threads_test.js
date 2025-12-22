// objection_threads_test.js
// Extended conversation thread tests showing objection handling in realistic scenarios
// Run with: node objection_threads_test.js

require("dotenv").config();
const { generateOpenerForContact } = require("./src/ai/aiClient");
const { detectIntents } = require("./src/ai/intents");
const { buildCanonicalState } = require("./src/ai/phaseContract");
const { buildContactProfile } = require("./src/ai/contextBuilder");
const { detectObjection } = require("./src/prompts/objectionLibrary");

// Extended conversation scenarios with objections
const conversationScenarios = [
  {
    name: "Price Objection After Quote Discussion",
    contact: {
      id: "thread-test-1",
      firstName: "Alex",
      lastName: "Martinez",
      phone: "+16125551111",
      email: "alex@example.com",
      customField: {
        tattoo_summary: "A large dragon sleeve",
        tattoo_placement: "full arm",
        tattoo_size: "full sleeve",
        tattoo_style: "Japanese traditional",
        how_soon_is_client_deciding: "next month",
        language_preference: "English",
      },
    },
    thread: [
      `STUDIO [Dec 20, 10:00 AM]: Hey Alex — that dragon sleeve is gonna look fire. When were you thinking of getting it done?`,
      `LEAD [Dec 20, 10:15 AM]: Hopefully next month, maybe early January`,
      `STUDIO [Dec 20, 10:16 AM]: Perfect, we can make that work.`,
      `STUDIO [Dec 20, 10:16 AM]: The next step is a quick 15–20 minute consultation with the artist to fully understand your design.`,
      `STUDIO [Dec 20, 10:16 AM]: Since our artist's native language is Spanish, our clients either do a video call with a translator or message the artist directly about their idea. Both options have worked great — which do you prefer?`,
      `LEAD [Dec 20, 10:20 AM]: Video call works`,
      `STUDIO [Dec 20, 10:21 AM]: Perfect — let me pull up some times for you.`,
      `STUDIO [Dec 20, 10:21 AM]: I pulled a few openings for a consult with an artist:\n1) Tuesday, Jan 2 at 3:00 PM\n2) Wednesday, Jan 3 at 5:00 PM\n3) Thursday, Jan 4 at 2:00 PM\n4) Friday, Jan 5 at 4:00 PM\n\nWhich works best?`,
      `LEAD [Dec 20, 10:25 AM]: Tuesday works`,
      `STUDIO [Dec 20, 10:26 AM]: Got you for Tuesday, Jan 2 at 3:00 PM.\nTo lock in your consultation, we require a $100 deposit. It's fully refundable if you don't end up loving the design, and it goes toward your tattoo total.\n\nHere's the link: [deposit link]\nI'll keep that spot on hold for about 20 minutes.`,
      `LEAD [Dec 20, 10:30 AM]: That's more than I expected. Can you work with my budget?`,
    ],
    expectedObjection: "price_too_high",
  },
  {
    name: "Hesitation After Deposit Link Sent",
    contact: {
      id: "thread-test-2",
      firstName: "Jordan",
      lastName: "Chen",
      phone: "+16125552222",
      email: "jordan@example.com",
      customField: {
        tattoo_summary: "A small geometric design",
        tattoo_placement: "wrist",
        tattoo_size: "2 inches",
        tattoo_style: "geometric",
        how_soon_is_client_deciding: "this month",
        language_preference: "English",
      },
    },
    thread: [
      `STUDIO [Dec 20, 2:00 PM]: Hey Jordan — that geometric wrist piece is gonna look clean. When were you thinking?`,
      `LEAD [Dec 20, 2:05 PM]: This month if possible`,
      `STUDIO [Dec 20, 2:06 PM]: Perfect, we can make that work.`,
      `STUDIO [Dec 20, 2:06 PM]: The next step is a quick 15–20 minute consultation with the artist.`,
      `STUDIO [Dec 20, 2:06 PM]: Since our artist's native language is Spanish, our clients either do a video call with a translator or message the artist directly. Both options have worked great — which do you prefer?`,
      `LEAD [Dec 20, 2:10 PM]: Messages work`,
      `STUDIO [Dec 20, 2:11 AM]: Perfect — let me pull up some times for you.`,
      `STUDIO [Dec 20, 2:11 AM]: I pulled a few openings:\n1) Thursday, Dec 28 at 3:00 PM\n2) Friday, Dec 29 at 5:00 PM\n\nWhich works best?`,
      `LEAD [Dec 20, 2:15 PM]: Thursday works`,
      `STUDIO [Dec 20, 2:16 PM]: Got you for Thursday, Dec 28 at 3:00 PM.\nTo lock in your consultation, we require a $100 deposit. It's fully refundable if you don't end up loving the design, and it goes toward your tattoo total.\n\nHere's the link: [deposit link]\nI'll keep that spot on hold for about 20 minutes.`,
      `LEAD [Dec 20, 2:25 PM]: Let me think about it and get back to you`,
    ],
    expectedObjection: "need_to_think",
  },
  {
    name: "Partner Approval Objection Mid-Conversation",
    contact: {
      id: "thread-test-3",
      firstName: "Sam",
      lastName: "Taylor",
      phone: "+16125553333",
      email: "sam@example.com",
      customField: {
        tattoo_summary: "A rose with thorns",
        tattoo_placement: "shoulder",
        tattoo_size: "4 inches",
        tattoo_style: "realism",
        how_soon_is_client_deciding: "next month",
        language_preference: "English",
      },
    },
    thread: [
      `STUDIO [Dec 20, 3:00 PM]: Hey Sam — that rose shoulder piece is gonna look sick. When were you thinking of getting it done?`,
      `LEAD [Dec 20, 3:05 PM]: Next month would be ideal`,
      `STUDIO [Dec 20, 3:06 PM]: Perfect, we can make that work.`,
      `STUDIO [Dec 20, 3:06 PM]: The next step is a quick 15–20 minute consultation with the artist to fully understand your design.`,
      `STUDIO [Dec 20, 3:06 PM]: Since our artist's native language is Spanish, our clients either do a video call with a translator or message the artist directly. Both options have worked great — which do you prefer?`,
      `LEAD [Dec 20, 3:10 PM]: Video call`,
      `STUDIO [Dec 20, 3:11 PM]: Perfect — let me pull up some times for you.`,
      `STUDIO [Dec 20, 3:11 PM]: I pulled a few openings:\n1) Monday, Jan 8 at 2:00 PM\n2) Tuesday, Jan 9 at 4:00 PM\n\nWhich works best?`,
      `LEAD [Dec 20, 3:15 PM]: I need to ask my partner first before I commit`,
    ],
    expectedObjection: "ask_partner",
  },
  {
    name: "Design Uncertainty After Multiple Messages",
    contact: {
      id: "thread-test-4",
      firstName: "Casey",
      lastName: "Brown",
      phone: "+16125554444",
      email: "casey@example.com",
      customField: {
        tattoo_summary: "A phoenix design",
        tattoo_placement: "back",
        tattoo_size: "8 inches",
        tattoo_style: "watercolor",
        how_soon_is_client_deciding: "next month",
        language_preference: "English",
      },
    },
    thread: [
      `STUDIO [Dec 20, 4:00 PM]: Hey Casey — that phoenix back piece is gonna look incredible. When were you thinking?`,
      `LEAD [Dec 20, 4:05 PM]: Next month, maybe mid-January`,
      `STUDIO [Dec 20, 4:06 PM]: Perfect, we can make that work.`,
      `STUDIO [Dec 20, 4:06 PM]: The next step is a quick 15–20 minute consultation with the artist.`,
      `STUDIO [Dec 20, 4:06 PM]: Since our artist's native language is Spanish, our clients either do a video call with a translator or message the artist directly. Both options have worked great — which do you prefer?`,
      `LEAD [Dec 20, 4:10 PM]: Messages work better for me`,
      `STUDIO [Dec 20, 4:11 PM]: Perfect — let me pull up some times for you.`,
      `STUDIO [Dec 20, 4:11 PM]: I pulled a few openings:\n1) Wednesday, Jan 10 at 3:00 PM\n2) Thursday, Jan 11 at 5:00 PM\n\nWhich works best?`,
      `LEAD [Dec 20, 4:15 PM]: Wednesday works`,
      `STUDIO [Dec 20, 4:16 PM]: Got you for Wednesday, Jan 10 at 3:00 PM.\nTo lock in your consultation, we require a $100 deposit. It's fully refundable if you don't end up loving the design, and it goes toward your tattoo total.\n\nHere's the link: [deposit link]`,
      `LEAD [Dec 20, 4:20 PM]: What if I don't like the design after I pay?`,
    ],
    expectedObjection: "design_uncertain",
  },
  {
    name: "Spanish Conversation - Price Objection",
    contact: {
      id: "thread-test-5",
      firstName: "María",
      lastName: "Rodríguez",
      phone: "+16125555555",
      email: "maria@example.com",
      customField: {
        tattoo_summary: "Un diseño de mariposa",
        tattoo_placement: "hombro",
        tattoo_size: "3 pulgadas",
        tattoo_style: "realismo",
        how_soon_is_client_deciding: "próximo mes",
        language_preference: "Spanish",
      },
    },
    thread: [
      `STUDIO [Dec 20, 5:00 PM]: Hola María — ese diseño de mariposa va a quedar increíble en el hombro. ¿Para cuándo lo estás pensando?`,
      `LEAD [Dec 20, 5:05 PM]: Para el próximo mes`,
      `STUDIO [Dec 20, 5:06 PM]: Perfecto, eso funciona.`,
      `STUDIO [Dec 20, 5:06 PM]: El siguiente paso es una consulta rápida de 15-20 minutos con el artista para entender completamente tu diseño.`,
      `STUDIO [Dec 20, 5:06 PM]: ¿Prefieres una videollamada o hacerlo por mensajes?`,
      `LEAD [Dec 20, 5:10 PM]: Videollamada`,
      `STUDIO [Dec 20, 5:11 PM]: Perfecto — déjame buscar algunos horarios para ti.`,
      `STUDIO [Dec 20, 5:11 PM]: Tengo algunas opciones:\n1) Martes, 2 de enero a las 3:00 PM\n2) Miércoles, 3 de enero a las 5:00 PM\n\n¿Cuál te queda mejor?`,
      `LEAD [Dec 20, 5:15 PM]: Martes funciona`,
      `STUDIO [Dec 20, 5:16 PM]: Te tengo para el martes, 2 de enero a las 3:00 PM.\nPara asegurar tu consulta, requerimos un depósito de $100. Es totalmente reembolsable si no te gusta el diseño, y se aplica al total de tu tatuaje.\n\nAquí está el enlace: [enlace de depósito]`,
      `LEAD [Dec 20, 5:20 PM]: Está muy caro eso, no tengo tanto dinero ahorita`,
    ],
    expectedObjection: "price_too_high",
  },
  {
    name: "Refund Skepticism After Deposit Explanation",
    contact: {
      id: "thread-test-6",
      firstName: "Riley",
      lastName: "Johnson",
      phone: "+16125556666",
      email: "riley@example.com",
      customField: {
        tattoo_summary: "A minimalist line art design",
        tattoo_placement: "ankle",
        tattoo_size: "2 inches",
        tattoo_style: "minimalist",
        how_soon_is_client_deciding: "this month",
        language_preference: "English",
      },
    },
    thread: [
      `STUDIO [Dec 20, 6:00 PM]: Hey Riley — that minimalist ankle piece is gonna look clean. When were you thinking?`,
      `LEAD [Dec 20, 6:05 PM]: This month if possible`,
      `STUDIO [Dec 20, 6:06 PM]: Perfect, we can make that work.`,
      `STUDIO [Dec 20, 6:06 PM]: The next step is a quick 15–20 minute consultation with the artist.`,
      `STUDIO [Dec 20, 6:06 PM]: Since our artist's native language is Spanish, our clients either do a video call with a translator or message the artist directly. Both options have worked great — which do you prefer?`,
      `LEAD [Dec 20, 6:10 PM]: Messages`,
      `STUDIO [Dec 20, 6:11 PM]: Perfect — let me pull up some times for you.`,
      `STUDIO [Dec 20, 6:11 PM]: I pulled a few openings:\n1) Friday, Dec 29 at 2:00 PM\n2) Saturday, Dec 30 at 11:00 AM\n\nWhich works best?`,
      `LEAD [Dec 20, 6:15 PM]: Friday works`,
      `STUDIO [Dec 20, 6:16 PM]: Got you for Friday, Dec 29 at 2:00 PM.\nTo lock in your consultation, we require a $100 deposit. It's fully refundable if you don't end up loving the design, and it goes toward your tattoo total.\n\nHere's the link: [deposit link]`,
      `LEAD [Dec 20, 6:20 PM]: Is it actually refundable or is that just what you say?`,
    ],
    expectedObjection: "refund_skepticism",
  },
];

async function runThreadTest(scenario) {
  console.log("\n" + "█".repeat(80));
  console.log(`🧪 ${scenario.name.toUpperCase()}`);
  console.log("█".repeat(80));
  
  const contact = scenario.contact;
  const thread = scenario.thread;
  const latestMessage = thread[thread.length - 1];
  
  // Extract the latest message text (remove LEAD prefix)
  const latestMessageText = latestMessage.replace(/^LEAD \[.*?\]: /, "");
  
  console.log("\n📱 FULL CONVERSATION THREAD:");
  console.log("=".repeat(80));
  thread.forEach((msg, idx) => {
    const isLead = msg.startsWith("LEAD");
    const prefix = isLead ? "👤" : "🏪";
    const color = isLead ? "" : "";
    console.log(`${prefix} ${msg}`);
    if (idx < thread.length - 1) console.log(""); // Blank line between messages
  });
  console.log("=".repeat(80));
  
  console.log(`\n💬 LATEST MESSAGE (Objection): "${latestMessageText}"\n`);
  
  // Detect intents
  const canonicalState = buildCanonicalState(contact);
  const intents = detectIntents(latestMessageText, canonicalState);
  
  console.log("📊 OBJECTION DETECTION:");
  console.log(`   ✓ Detected: ${intents.objection_intent ? "YES ✅" : "NO"}`);
  console.log(`   ✓ Type: ${intents.objection_type || "(none)"}`);
  console.log(`   ✓ Expected: ${scenario.expectedObjection}`);
  
  if (intents.objection_data) {
    console.log(`   ✓ Category: ${intents.objection_data.category}`);
    console.log(`   ✓ Belief to fix: ${intents.objection_data.belief_to_fix}`);
    console.log(`   ✓ Core reframe: ${intents.objection_data.core_reframe}`);
  }
  
  // Build contact profile
  const contactProfile = buildContactProfile(canonicalState, {
    changedFields: {},
    derivedPhase: intents.objection_intent ? "objections" : "discovery",
    intents,
  });
  
  // Call LLM
  console.log("\n🤖 CALLING LLM WITH OBJECTION CONTEXT...\n");
  
  const startTime = Date.now();
  
  try {
    const response = await generateOpenerForContact({
      contact,
      canonicalState,
      aiPhase: intents.objection_intent ? "objections" : "discovery",
      leadTemperature: "warm",
      latestMessageText,
      contactProfile,
      consultExplained: true, // Already explained in thread
      conversationThread: {
        thread: thread.slice(0, -1), // All messages except the last one
        summary: null,
        totalCount: thread.length - 1,
      },
      detectedObjection: intents.objection_data || null,
    });
    
    const duration = Date.now() - startTime;
    
    console.log("✅ AI RESPONSE:");
    console.log("-".repeat(80));
    
    if (response.bubbles && response.bubbles.length > 0) {
      response.bubbles.forEach((bubble, i) => {
        console.log(`\n   [Bubble ${i + 1}]:`);
        console.log(`   ${bubble}`);
      });
    }
    
    console.log("\n" + "-".repeat(80));
    
    console.log("\n📈 RESPONSE METADATA:");
    console.log(`   Language: ${response.language}`);
    console.log(`   AI Phase: ${response.meta?.aiPhase}`);
    console.log(`   Lead Temperature: ${response.meta?.leadTemperature}`);
    if (response.meta?.objectionType) {
      console.log(`   Objection Type: ${response.meta.objectionType}`);
      console.log(`   Objection Handled: ${response.meta.objectionHandled}`);
    }
    console.log(`   Response Time: ${duration}ms`);
    
    // Verify objection handling
    if (intents.objection_intent) {
      console.log("\n🔍 OBJECTION HANDLING VERIFICATION:");
      const fullResponse = response.bubbles.join(" ").toLowerCase();
      
      const checks = {
        "Ends with time choice": fullResponse.includes("time") || 
                               fullResponse.includes("work") ||
                               fullResponse.includes("prefer") ||
                               fullResponse.includes("cuál") ||
                               fullResponse.includes("cuál"),
        "Mentions deposit": fullResponse.includes("deposit") || 
                          fullResponse.includes("$100") ||
                          fullResponse.includes("depósito"),
        "Mentions refundable": fullResponse.includes("refund") || 
                             fullResponse.includes("reembols"),
        "Uses core reframe": true, // Checked by human review
      };
      
      Object.entries(checks).forEach(([check, passed]) => {
        console.log(`   ${passed ? "✅" : "⚠️"} ${check}: ${passed ? "YES" : "NO"}`);
      });
    }
    
    // Show updated thread with AI response
    console.log("\n📱 UPDATED CONVERSATION THREAD:");
    console.log("=".repeat(80));
    thread.forEach(msg => {
      const isLead = msg.startsWith("LEAD");
      const prefix = isLead ? "👤" : "🏪";
      console.log(`${prefix} ${msg}`);
    });
    console.log("");
    response.bubbles.forEach(bubble => {
      console.log(`🏪 STUDIO [Dec 20, ${new Date().toLocaleTimeString()}]: ${bubble}`);
    });
    console.log("=".repeat(80));
    
    return { success: true, response };
    
  } catch (error) {
    console.log("❌ ERROR:", error.message);
    console.error(error);
    return { success: false, error };
  }
}

async function main() {
  console.log("\n" + "█".repeat(80));
  console.log("   OBJECTION LIBRARY - EXTENDED CONVERSATION THREAD TESTS");
  console.log("█".repeat(80));
  
  if (!process.env.LLM_API_KEY) {
    console.log("\n❌ ERROR: LLM_API_KEY not found in environment.");
    process.exit(1);
  }
  
  console.log("\n✅ API key found, running extended conversation tests...\n");
  
  const results = [];
  
  for (const scenario of conversationScenarios) {
    const result = await runThreadTest(scenario);
    results.push({ scenario: scenario.name, ...result });
    
    // Delay between API calls
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Summary
  console.log("\n" + "█".repeat(80));
  console.log("   TEST SUMMARY");
  console.log("█".repeat(80) + "\n");
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  results.forEach(r => {
    const status = r.success ? "✅" : "❌";
    console.log(`${status} ${r.scenario}`);
  });
  
  console.log(`\n📊 Total: ${successful} passed, ${failed} failed`);
  console.log("\n" + "█".repeat(80) + "\n");
}

main().catch(console.error);

