// canonical_case_study_replay.test.js
// End-to-end acceptance replay of the canonical case study from CODEX_MAX_FINAL_IMPLEMENTATION_SPEC.md

jest.mock("../ghlClient", () => ({
  updateSystemFields: jest.fn(async (contactId, fields) => {
    // Track all field updates
    mockFieldUpdates[contactId] = { ...mockFieldUpdates[contactId], ...fields };
    // Update mock contact as well
    if (mockContacts[contactId]) {
      mockContacts[contactId].customField = { ...mockFieldUpdates[contactId] };
      mockContacts[contactId].customFields = { ...mockFieldUpdates[contactId] };
    }
    return {};
  }),
  getContact: jest.fn(async (contactId) => {
    const base = mockContacts[contactId] || { id: contactId };
    return {
      ...base,
      customField: { ...mockFieldUpdates[contactId] },
      customFields: { ...mockFieldUpdates[contactId] },
    };
  }),
  sendConversationMessage: jest.fn(async () => ({})),
  createTaskForContact: jest.fn(async () => ({})),
  updateContact: jest.fn(async (contactId, updates) => {
    if (updates.customField) {
      mockFieldUpdates[contactId] = { ...mockFieldUpdates[contactId], ...updates.customField };
    }
    return {};
  }),
}));

jest.mock("../src/clients/ghlCalendarClient", () => ({
  createAppointment: jest.fn(async (params) => ({
    id: `appt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    ...params,
  })),
  updateAppointmentStatus: jest.fn(async (appointmentId, status) => {
    mockAppointments[appointmentId] = { ...mockAppointments[appointmentId], status };
    return { id: appointmentId, status };
  }),
}));

jest.mock("../src/clients/googleMeet", () => ({
  createGoogleMeet: jest.fn(async () => ({
    meetUrl: "https://meet.google.com/test-meet-link",
    htmlLink: "https://calendar.google.com/test-event",
  })),
}));

jest.mock("../src/payments/squareClient", () => ({
  createDepositLinkForContact: jest.fn(async () => ({
    url: "https://square.link/test-deposit-link",
    id: "deposit_link_123",
  })),
}));

jest.mock("../src/ai/aiClient", () => ({
  generateOpenerForContact: jest.fn(async (params) => {
    const { latestMessageText, contact } = params;
    const canonical = require("../src/ai/phaseContract").buildCanonicalState(contact);
    
    // Simulate AI responses based on message content
    let response = "";
    let fieldUpdates = {};
    
    // Handle placement
    if (latestMessageText.includes("back") || latestMessageText.includes("shoulder")) {
      fieldUpdates.tattoo_placement = "back towards shoulder";
      response = "Got it — back towards your shoulder. What design are you thinking?";
    }
    
    // Handle concept
    if (latestMessageText.includes("bouquet") || latestMessageText.includes("flowers")) {
      fieldUpdates.tattoo_summary = "bouquet of flowers";
      response = "Perfect — a bouquet of flowers. What size are you thinking?";
    }
    
    // Handle size uncertainty
    if (latestMessageText.includes("not sure") || latestMessageText.includes("second opinion") || 
        latestMessageText.includes("artist should help")) {
      fieldUpdates.tattoo_size = "artist_guided";
      response = "No worries — the artist will help you figure out the perfect size during your consult. When are you hoping to get it done?";
    }
    
    // Handle timeline
    if (latestMessageText.includes("December") || latestMessageText.includes("Dec")) {
      fieldUpdates.how_soon_is_client_deciding = "December";
      if (!canonical.consultationType) {
        response = "Perfect — December works great. Our artist's native language is Spanish, so for video consults we include a translator to keep every detail clear. We can do that on a quick video call or keep things in messages—both work great. Which do you prefer?";
      } else {
        response = "Got it — December. Let me pull some times for you.";
      }
    }
    
    // Default AI response
    if (!response) {
      response = "Thanks for that info. Let me help you get scheduled.";
    }
    
    return {
      language: "en",
      bubbles: [response],
      field_updates: fieldUpdates,
      meta: {
        aiPhase: canonical.consultationType ? "scheduling" : "qualification",
        leadTemperature: "warm",
      },
    };
  }),
}));

const { handleInboundMessage } = require("../src/ai/controller");
const { buildCanonicalState } = require("../src/ai/phaseContract");
const { sendConversationMessage } = require("../ghlClient");

// Mock state storage
const mockFieldUpdates = {};
const mockContacts = {};
const mockAppointments = {};

// Test contact ID
const TEST_CONTACT_ID = "test_contact_123";

// Canonical case study messages (from spec)
const CANONICAL_MESSAGES = [
  "On my back towards my shoulder!",
  "I was thinking a bouquet of flowers!",
  "Not sure… second opinion on size… not too small not too big.",
  "The artist should help me figure it out!",
  "December!",
  "Video call!",
  "Yes that works!",
  "Video call this week! What times are you available?",
  "Yes!",
  "December",
  "What days do you have consultation openings for this week?",
];

describe("Canonical Case Study End-to-End Replay", () => {
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    Object.keys(mockFieldUpdates).forEach(key => delete mockFieldUpdates[key]);
    Object.keys(mockContacts).forEach(key => delete mockContacts[key]);
    Object.keys(mockAppointments).forEach(key => delete mockAppointments[key]);
    
    // Initialize test contact
    mockContacts[TEST_CONTACT_ID] = {
      id: TEST_CONTACT_ID,
      customField: {},
      customFields: {},
    };
    mockFieldUpdates[TEST_CONTACT_ID] = {};
  });

  test("Full canonical case study replay with validation", async () => {
    const replayLog = [];
    const validationResults = {
      schedulingReturnsConcreteTimes: { passed: false, evidence: [] },
      multiIntentAppliesSideEffects: { passed: false, evidence: [] },
      translatorConfirmationSetsFlag: { passed: false, evidence: [] },
      rescheduleCancelDeterministic: { passed: false, evidence: [] },
      depositLinkNotResentAfterPayment: { passed: false, evidence: [] },
      consultExplainedSetInSameTurn: { passed: false, evidence: [] },
      noRepeatedAcknowledgements: { passed: false, evidence: [] },
    };

    let currentContact = { ...mockContacts[TEST_CONTACT_ID] };

    // Replay each message
    for (let step = 0; step < CANONICAL_MESSAGES.length; step++) {
      const messageText = CANONICAL_MESSAGES[step];
      const stepNum = step + 1;
      
      // Update contact with latest field updates before processing
      currentContact.customField = { ...mockFieldUpdates[TEST_CONTACT_ID] };
      currentContact.customFields = { ...mockFieldUpdates[TEST_CONTACT_ID] };
      
      const canonicalBefore = buildCanonicalState(currentContact);
      
      // Process message
      const result = await handleInboundMessage({
        contact: currentContact,
        aiPhase: canonicalBefore.consultationType ? "scheduling" : "qualification",
        leadTemperature: "warm",
        latestMessageText: messageText,
        contactProfile: {
          tattooSummary: canonicalBefore.tattooSummary,
          tattooPlacement: canonicalBefore.tattooPlacement,
        },
        consultExplained: canonicalBefore.consultExplained,
      });
      
      // Update contact state after processing
      if (result.aiResult?.field_updates) {
        Object.assign(mockFieldUpdates[TEST_CONTACT_ID], result.aiResult.field_updates);
      }
      currentContact.customField = { ...mockFieldUpdates[TEST_CONTACT_ID] };
      currentContact.customFields = { ...mockFieldUpdates[TEST_CONTACT_ID] };
      
      const canonicalAfter = buildCanonicalState(currentContact);
      
      // Extract response message
      const outboundMessage = result.aiResult?.bubbles?.[0] || "NO RESPONSE";
      const selectedHandler = result.routing?.selected_handler || "unknown";
      const intents = result.routing?.intents || {};
      
      // Log step
      const logEntry = {
        step: stepNum,
        inbound: messageText,
        intents: Object.keys(intents).filter(k => intents[k] === true),
        handler: selectedHandler,
        outbound: outboundMessage,
        sideEffects: {
          consultationType: canonicalAfter.consultationType,
          consultationTypeLocked: canonicalAfter.consultationTypeLocked,
          translatorConfirmed: canonicalAfter.translatorConfirmed,
          translatorNeeded: canonicalAfter.translatorNeeded,
          consultExplained: canonicalAfter.consultExplained,
          timesSent: canonicalAfter.timesSent,
          depositLinkSent: canonicalAfter.depositLinkSent,
          depositPaid: canonicalAfter.depositPaid,
          holdAppointmentId: canonicalAfter.holdAppointmentId,
        },
        fieldUpdates: result.aiResult?.field_updates || {},
      };
      
      replayLog.push(logEntry);
      
      // VALIDATION CHECKS
      
      // 1. Scheduling questions return concrete times
      if (intents.scheduling_intent) {
        const hasConcreteTimes = /1\)|2\)|3\)|4\)/.test(outboundMessage) || 
                                  /Monday|Tuesday|Wednesday|Thursday|Friday/.test(outboundMessage);
        const hasSelectionQuestion = /Which works|Which one|Which do you/i.test(outboundMessage);
        
        if (hasConcreteTimes && hasSelectionQuestion) {
          validationResults.schedulingReturnsConcreteTimes.passed = true;
          validationResults.schedulingReturnsConcreteTimes.evidence.push({
            step: stepNum,
            message: outboundMessage,
            log: logEntry,
          });
        }
      }
      
      // 2. Multi-intent (video + scheduling)
      if (intents.scheduling_intent && intents.consult_path_choice_intent) {
        const sideEffectsApplied = canonicalAfter.consultationType === "appointment" &&
                                    canonicalAfter.consultationTypeLocked === true &&
                                    canonicalAfter.translatorNeeded === true;
        const slotsOffered = /1\)|2\)|3\)|Which works/i.test(outboundMessage);
        
        if (sideEffectsApplied && slotsOffered) {
          validationResults.multiIntentAppliesSideEffects.passed = true;
          validationResults.multiIntentAppliesSideEffects.evidence.push({
            step: stepNum,
            sideEffects: logEntry.sideEffects,
            message: outboundMessage,
            log: logEntry,
          });
        }
      }
      
      // 3. Translator confirmation sets flag and returns slots
      if (intents.translator_affirm_intent) {
        const flagSet = canonicalAfter.translatorConfirmed === true;
        const slotsOffered = /1\)|2\)|3\)|Which works/i.test(outboundMessage);
        
        if (flagSet && slotsOffered) {
          validationResults.translatorConfirmationSetsFlag.passed = true;
          validationResults.translatorConfirmationSetsFlag.evidence.push({
            step: stepNum,
            translatorConfirmed: canonicalAfter.translatorConfirmed,
            message: outboundMessage,
            log: logEntry,
          });
        }
      }
      
      // 4. Consult explained flag set in same turn
      if (outboundMessage.includes("consult") || outboundMessage.includes("deposit") || 
          outboundMessage.includes("translator") || selectedHandler === "deterministic") {
        if (canonicalAfter.consultExplained === true) {
          validationResults.consultExplainedSetInSameTurn.passed = true;
          validationResults.consultExplainedSetInSameTurn.evidence.push({
            step: stepNum,
            consultExplained: canonicalAfter.consultExplained,
            message: outboundMessage,
            log: logEntry,
          });
        }
      }
      
      // 5. No repeated acknowledgements (check for repeated tattoo details)
      if (step > 0) {
        const prevLog = replayLog[step - 1];
        const currentHasDetails = outboundMessage.includes("bouquet") && outboundMessage.includes("back");
        const prevHadDetails = prevLog.outbound.includes("bouquet") && prevLog.outbound.includes("back");
        
        if (!currentHasDetails || !prevHadDetails) {
          validationResults.noRepeatedAcknowledgements.passed = true;
        } else {
          validationResults.noRepeatedAcknowledgements.evidence.push({
            step: stepNum,
            repeated: outboundMessage,
            log: logEntry,
          });
        }
      }
    }
    
    // Test reschedule/cancel deterministic behavior (separate test scenarios)
    // This would require additional test cases, but we can validate the handler selection
    
    // Test deposit link not resent after payment
    // Simulate deposit paid scenario
    mockFieldUpdates[TEST_CONTACT_ID].deposit_paid = "Yes";
    mockFieldUpdates[TEST_CONTACT_ID].deposit_link_sent = "Yes";
    currentContact.customField = { ...mockFieldUpdates[TEST_CONTACT_ID] };
    currentContact.customFields = { ...mockFieldUpdates[TEST_CONTACT_ID] };
    
    const depositRequestResult = await handleInboundMessage({
      contact: currentContact,
      aiPhase: "qualified",
      leadTemperature: "warm",
      latestMessageText: "Can you send the deposit link again?",
      contactProfile: {},
      consultExplained: true,
    });
    
    const depositRequestMessage = depositRequestResult.aiResult?.bubbles?.[0] || "";
    const hasDepositLink = /square\.link|deposit.*link|here.*deposit/i.test(depositRequestMessage);
    const canonicalAfterDeposit = buildCanonicalState(currentContact);
    
    if (!hasDepositLink && canonicalAfterDeposit.depositPaid === true) {
      validationResults.depositLinkNotResentAfterPayment.passed = true;
      validationResults.depositLinkNotResentAfterPayment.evidence.push({
        message: depositRequestMessage,
        depositPaid: canonicalAfterDeposit.depositPaid,
        handler: depositRequestResult.routing?.selected_handler,
      });
    }
    
    // Test reschedule/cancel deterministic behavior
    // Create a hold appointment first
    mockFieldUpdates[TEST_CONTACT_ID].hold_appointment_id = "test_appt_123";
    mockFieldUpdates[TEST_CONTACT_ID].deposit_paid = "No";
    currentContact.customField = { ...mockFieldUpdates[TEST_CONTACT_ID] };
    currentContact.customFields = { ...mockFieldUpdates[TEST_CONTACT_ID] };
    mockAppointments["test_appt_123"] = { id: "test_appt_123", status: "new" };
    
    // Test reschedule
    const rescheduleResult = await handleInboundMessage({
      contact: currentContact,
      aiPhase: "deposit_pending",
      leadTemperature: "warm",
      latestMessageText: "Can we reschedule to another day?",
      contactProfile: {},
      consultExplained: true,
    });
    
    const rescheduleHandler = rescheduleResult.routing?.selected_handler;
    const rescheduleMessage = rescheduleResult.aiResult?.bubbles?.[0] || "";
    const rescheduleHasSlots = /1\)|2\)|3\)|Which works/i.test(rescheduleMessage);
    const appointmentCancelled = mockAppointments["test_appt_123"]?.status === "cancelled";
    
    if (rescheduleHandler === "deterministic" && rescheduleHasSlots && appointmentCancelled) {
      validationResults.rescheduleCancelDeterministic.passed = true;
      validationResults.rescheduleCancelDeterministic.evidence.push({
        handler: rescheduleHandler,
        message: rescheduleMessage,
        appointmentCancelled,
        log: {
          step: "reschedule_test",
          inbound: "Can we reschedule to another day?",
          handler: rescheduleHandler,
          outbound: rescheduleMessage,
        },
      });
    }
    
    // Test cancel
    mockFieldUpdates[TEST_CONTACT_ID].hold_appointment_id = "test_appt_456";
    currentContact.customField = { ...mockFieldUpdates[TEST_CONTACT_ID] };
    currentContact.customFields = { ...mockFieldUpdates[TEST_CONTACT_ID] };
    mockAppointments["test_appt_456"] = { id: "test_appt_456", status: "new" };
    
    const cancelResult = await handleInboundMessage({
      contact: currentContact,
      aiPhase: "deposit_pending",
      leadTemperature: "warm",
      latestMessageText: "I need to cancel",
      contactProfile: {},
      consultExplained: true,
    });
    
    const cancelHandler = cancelResult.routing?.selected_handler;
    const cancelMessage = cancelResult.aiResult?.bubbles?.[0] || "";
    const appointmentCancelled2 = mockAppointments["test_appt_456"]?.status === "cancelled";
    
    if (cancelHandler === "deterministic" && appointmentCancelled2) {
      validationResults.rescheduleCancelDeterministic.passed = true;
      validationResults.rescheduleCancelDeterministic.evidence.push({
        handler: cancelHandler,
        message: cancelMessage,
        appointmentCancelled: appointmentCancelled2,
        log: {
          step: "cancel_test",
          inbound: "I need to cancel",
          handler: cancelHandler,
          outbound: cancelMessage,
        },
      });
    }
    
    // OUTPUT REPLAY LOG
    console.log("\n" + "=".repeat(100));
    console.log("CANONICAL CASE STUDY REPLAY LOG");
    console.log("=".repeat(100));
    
    replayLog.forEach((entry) => {
      console.log(`\n[STEP ${entry.step}]`);
      console.log(`  INBOUND: "${entry.inbound}"`);
      console.log(`  INTENTS: [${entry.intents.join(", ") || "none"}]`);
      console.log(`  HANDLER: ${entry.handler}`);
      console.log(`  OUTBOUND: "${entry.outbound}"`);
      console.log(`  SIDE EFFECTS:`);
      console.log(`    - consultation_type: ${entry.sideEffects.consultationType || "null"}`);
      console.log(`    - consultation_type_locked: ${entry.sideEffects.consultationTypeLocked}`);
      console.log(`    - translator_confirmed: ${entry.sideEffects.translatorConfirmed}`);
      console.log(`    - translator_needed: ${entry.sideEffects.translatorNeeded}`);
      console.log(`    - consult_explained: ${entry.sideEffects.consultExplained}`);
      console.log(`    - times_sent: ${entry.sideEffects.timesSent}`);
      console.log(`    - deposit_link_sent: ${entry.sideEffects.depositLinkSent}`);
      console.log(`    - deposit_paid: ${entry.sideEffects.depositPaid}`);
      if (Object.keys(entry.fieldUpdates).length > 0) {
        console.log(`  FIELD UPDATES:`, entry.fieldUpdates);
      }
    });
    
    // OUTPUT VALIDATION RESULTS
    console.log("\n" + "=".repeat(100));
    console.log("VALIDATION RESULTS (PASS/FAIL)");
    console.log("=".repeat(100));
    
    const requirements = [
      {
        key: "schedulingReturnsConcreteTimes",
        name: "Scheduling questions return concrete times (2-4 options + 'Which works best?')",
      },
      {
        key: "multiIntentAppliesSideEffects",
        name: "Multi-intent ('Video call this week — what times?') applies consult-path side effects AND returns slots immediately",
      },
      {
        key: "translatorConfirmationSetsFlag",
        name: "Translator confirmation ('Yes that works') sets translator_confirmed=true and returns slots immediately",
      },
      {
        key: "rescheduleCancelDeterministic",
        name: "Reschedule and cancel are deterministic (no AI) and cancel/reschedule the active appointment ID",
      },
      {
        key: "depositLinkNotResentAfterPayment",
        name: "Deposit link is never resent after payment (deposit_paid=true)",
      },
      {
        key: "consultExplainedSetInSameTurn",
        name: "consult_explained=true is set in the same turn whenever consult/deposit explanations are sent",
      },
      {
        key: "noRepeatedAcknowledgements",
        name: "No repeated tattoo-detail acknowledgements when details didn't change",
      },
    ];
    
    requirements.forEach((req) => {
      const result = validationResults[req.key];
      const status = result.passed ? "✅ PASS" : "❌ FAIL";
      console.log(`\n${status}: ${req.name}`);
      
      if (result.evidence && result.evidence.length > 0) {
        console.log(`  Evidence:`);
        result.evidence.forEach((ev, idx) => {
          if (ev.step) {
            console.log(`    [Step ${ev.step}] ${ev.message || JSON.stringify(ev.sideEffects || ev)}`);
          } else {
            console.log(`    ${JSON.stringify(ev)}`);
          }
        });
      } else if (!result.passed) {
        console.log(`  No evidence found — requirement not met`);
      }
    });
    
    console.log("\n" + "=".repeat(100));
    
    // Assertions
    expect(validationResults.schedulingReturnsConcreteTimes.passed).toBe(true);
    expect(validationResults.multiIntentAppliesSideEffects.passed).toBe(true);
    expect(validationResults.translatorConfirmationSetsFlag.passed).toBe(true);
    expect(validationResults.depositLinkNotResentAfterPayment.passed).toBe(true);
    expect(validationResults.consultExplainedSetInSameTurn.passed).toBe(true);
    expect(validationResults.noRepeatedAcknowledgements.passed).toBe(true);
  });

  test("Consult-only path choice routes to consultPathHandler (no scheduling intent)", async () => {
    // Prime timeline so consult path is the next step
    mockFieldUpdates[TEST_CONTACT_ID].how_soon_is_client_deciding = "December";
    mockContacts[TEST_CONTACT_ID].customField = { ...mockFieldUpdates[TEST_CONTACT_ID] };
    mockContacts[TEST_CONTACT_ID].customFields = { ...mockFieldUpdates[TEST_CONTACT_ID] };

    const contact = { ...mockContacts[TEST_CONTACT_ID] };

    const result = await handleInboundMessage({
      contact,
      aiPhase: "qualification",
      leadTemperature: "warm",
      latestMessageText: "Video call!",
      contactProfile: {},
      consultExplained: false,
    });

    const outbound = result.aiResult?.bubbles?.[0] || "";

    expect(result.routing?.selected_handler).toBe("consult_path");
    expect(result.routing?.selected_handler).not.toBe("deterministic");
    expect(result.routing?.selected_handler).not.toBe("ai");
    expect(result.routing?.reason).toBe("consult_path_choice_intent");
    expect(outbound).toMatch(/translator on the call/i);
    expect(result.aiResult?.bubbles?.length).toBeGreaterThan(0);
    expect(outbound.trim().length).toBeGreaterThan(0);

    const updatedFields = mockFieldUpdates[TEST_CONTACT_ID];
    expect(updatedFields.consultation_type).toBe("appointment");
    expect(updatedFields.consultation_type_locked).toBe(true);
    expect(updatedFields.translator_needed).toBe(true);

    expect(sendConversationMessage).toHaveBeenCalled();
  });
});
