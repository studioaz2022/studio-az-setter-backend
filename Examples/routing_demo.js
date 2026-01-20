// routing_demo.js
// Demonstrates routing decision logic for 5 example messages

const { detectIntents } = require("../src/ai/intents");
const { detectPathChoice } = require("../src/ai/consultPathHandler");
const { isTimeSelection } = require("../src/ai/bookingController");

// Mock AI meta flags (what the AI would return)
const mockAIMeta = {
  wantsAppointmentOffer: false,
  wantsDepositLink: false,
  consultMode: "online",
};

// Example messages
const exampleMessages = [
  {
    text: "I'd like to do a video call with a translator",
    description: "Consultation path choice - requesting video with translator",
  },
  {
    text: "What times are you available this week?",
    description: "Scheduling intent - asking for availability",
  },
  {
    text: "Option 2 works for me",
    description: "Slot selection - choosing a time option",
  },
  {
    text: "Can we keep this in messages?",
    description: "Consultation path choice - preferring message-based consult",
  },
  {
    text: "How much does a half sleeve cost?",
    description: "Price question - general inquiry",
  },
  {
    text: "Video call this week — what times?",
    description: "Multi-intent: consult choice + scheduling (scheduling wins, consult applied as side effect)",
  },
];

/**
 * Simulate routing decision logic
 */
function routeMessage(messageText, aiMeta = mockAIMeta) {
  const routing = {
    message: messageText,
    intents: {},
    pathChoice: null,
    handler: null,
    reason: "",
  };

  // 1. Detect intents
  routing.intents = detectIntents(messageText);

  // 2. Check for consult path choice
  routing.pathChoice = detectPathChoice(messageText);

  // 3. Check for time selection (if slots were previously offered)
  const isTimeSelect = isTimeSelection(messageText, []);

  // 4. Routing decision logic
  // Precedence: reschedule/cancel → slot_selection → deposit → scheduling → consult_path_choice → price/process → AI fallback
  if (routing.intents.reschedule_intent || routing.intents.cancel_intent) {
    routing.handler = "bookingController";
    routing.reason = routing.intents.reschedule_intent
      ? "Detected reschedule intent"
      : "Detected cancel intent";
  } else if (routing.intents.slot_selection_intent || isTimeSelect) {
    routing.handler = "bookingController";
    routing.reason = "Detected time slot selection intent";
  } else if (routing.intents.deposit_intent || aiMeta.wantsDepositLink) {
    routing.handler = "paymentHandler";
    routing.reason = "Detected deposit intent or AI requested deposit link";
  } else if (routing.intents.scheduling_intent || aiMeta.wantsAppointmentOffer) {
    routing.handler = "bookingController";
    routing.reason = "Detected scheduling intent or AI requested appointment offer";
    if (routing.intents.consult_path_choice_intent) {
      routing.reason += " (consult-path applied as side effect)";
      routing.appliedConsultPath = true;
    }
  } else if (routing.intents.consult_path_choice_intent) {
    routing.handler = "consultPathHandler";
    routing.reason = `Detected consultation path choice: "${routing.pathChoice}"`;
  } else if (routing.intents.process_or_price_question_intent) {
    routing.handler = "controller (AI handler)";
    routing.reason = "Detected process/price question";
  } else {
    routing.handler = "controller (AI handler)";
    routing.reason = "Default: Route to AI message handler for general conversation";
  }

  return routing;
}

/**
 * Format routing decision for display
 */
function formatRoutingDecision(routing) {
  const activeIntents = Object.entries(routing.intents)
    .filter(([_, value]) => value === true)
    .map(([key]) => key)
    .join(", ");

  return {
    "Message": `"${routing.message}"`,
    "Detected Intents": activeIntents || "none",
    "Path Choice": routing.pathChoice || "none",
    "Selected Handler": routing.handler,
    "Reason": routing.reason,
  };
}

// Simulate detailed log output as it would appear in production
function simulateProductionLogs(routing, example) {
  const logs = [];
  
  logs.push(`\n📨 [INBOUND] Message received: "${routing.message}"`);
  logs.push(`🔍 [INTENT] Detected intents: ${JSON.stringify(routing.intents)}`);
  
  if (routing.pathChoice) {
    logs.push(`📝 [CONSULTATION_TYPE] Path choice detected: "${routing.pathChoice}"`);
  }
  
  if (routing.intents.scheduling_intent) {
    logs.push(`📅 [SCHEDULING] Scheduling intent detected - user asking for availability`);
  }
  
  if (routing.intents.slot_selection_intent) {
    logs.push(`✅ [SLOT_SELECTION] User selecting a time slot`);
  }
  
  logs.push(`🧭 [ROUTING] Handler selected: ${routing.handler}`);
  logs.push(`💡 [ROUTING] Reason: ${routing.reason}`);
  if (routing.appliedConsultPath) {
    logs.push(`[ROUTING] Also applied consult-path updates before scheduling`);
  }
  
  // Handler-specific log lines
  if (routing.handler === "consultPathHandler") {
    if (routing.pathChoice === "message") {
      logs.push(`📝 [CONSULTATION_TYPE] Setting consultation_type="message" for contact`);
      logs.push(`🏗️ [PIPELINE] Pipeline stage synced after consult mode = message`);
    } else if (routing.pathChoice === "translator") {
      logs.push(`📝 [CONSULTATION_TYPE] Setting consultation_type="appointment" (translator needed)`);
      logs.push(`🏗️ [PIPELINE] Pipeline stage synced after consult mode = appointment/translator`);
    }
  } else if (routing.handler === "bookingController") {
    if (routing.intents.scheduling_intent) {
      logs.push(`📅 [BOOKING] Generating appointment slots...`);
      logs.push(`📊 [ARTIST] Artist workloads checked for time-first routing`);
    } else if (routing.intents.slot_selection_intent) {
      logs.push(`✅ [BOOKING] Parsing time selection from message`);
      logs.push(`📅 [BOOKING] Creating appointment with selected slot`);
    }
  } else if (routing.handler === "controller (AI handler)") {
    logs.push(`🤖 [AI] Routing to AI handler for general conversation`);
    logs.push(`🧭 [PHASE] Current phase: discovery (example)`);
    logs.push(`🤖 [AI] Generating AI response...`);
  }
  
  return logs;
}

// Run routing demo
console.log("=".repeat(80));
console.log("ROUTING DECISION LOG FOR 5 EXAMPLE MESSAGES");
console.log("=".repeat(80));
console.log("");

exampleMessages.forEach((example, index) => {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`EXAMPLE ${index + 1}: ${example.description}`);
  console.log(`${"=".repeat(80)}`);
  
  const routing = routeMessage(example.text);
  const logs = simulateProductionLogs(routing, example);
  
  logs.forEach(log => console.log(log));
  
  console.log(`\n📋 Summary:`);
  const formatted = formatRoutingDecision(routing);
  Object.entries(formatted).forEach(([key, value]) => {
    console.log(`   ${key.padEnd(18)}: ${value}`);
  });
});

console.log("=".repeat(80));
console.log("ROUTING LOGIC SUMMARY");
console.log("=".repeat(80));
console.log(`
Routing Priority Order:
1. reschedule/cancel    → bookingController
2. slot selection       → bookingController
3. deposit intent       → paymentHandler
4. scheduling intent    → bookingController (apply consult-path side effects if present)
5. consult path choice  → consultPathHandler (consult-only)
6. price/process        → controller (AI handler) for now
7. fallback             → controller (AI handler)

Key Detection Methods:
- detectIntents()        → Pattern matching for scheduling, deposit, cancel, etc.
- detectPathChoice()     → Detects consultation path preferences
- isTimeSelection()      → Parses time slot selections from messages
- AI Meta Flags          → wantsAppointmentOffer, wantsDepositLink from AI response
`);
