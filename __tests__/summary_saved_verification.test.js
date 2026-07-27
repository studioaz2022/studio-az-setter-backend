// summary_saved_verification.test.js
// Verify that once summary is saved, "what times?" responses contain only times

jest.mock("../src/clients/ghlClient", () => ({
  updateSystemFields: jest.fn(async () => ({})),
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
  isTimeSelection: jest.fn(() => false),
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
const { buildDeterministicResponse } = require("../src/ai/deterministicResponses");

describe("Summary Saved Verification: 'what times?' contains only times", () => {
  test("response contains only times when summary is already saved", async () => {
    const messageText = "what times?";
    const contact = { id: "contact123" };
    
    // Summary already saved in canonical state
    const canonicalState = {
      tattooSummary: "Lion realism portrait on right forearm",
      tattooPlacement: "right forearm",
      tattooStyle: "realism",
      depositPaid: false,
    };

    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION: Summary Saved → Times Only Response");
    console.log("=".repeat(80));

    console.log(`\n📨 [INBOUND] Message: "${messageText}"`);
    console.log(`📊 [STATE] Tattoo summary saved: "${canonicalState.tattooSummary}"`);
    console.log(`📊 [STATE] Tattoo placement: "${canonicalState.tattooPlacement}"`);

    // Step 1: Detect scheduling intent
    const intents = detectIntents(messageText);
    console.log(`🔍 [INTENT] Detected intents:`, JSON.stringify(intents, null, 2));

    expect(intents.scheduling_intent).toBe(true);

    // Step 2: Build deterministic response
    console.log(`\n📝 [RESPONSE] Generating scheduling response...`);

    const response = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState,
      contact,
      messageText,
    });

    console.log(`\n📝 [RESPONSE] Generated response:`);
    console.log(`   Message: "${response.bubbles[0]}"`);
    console.log(`   Internal notes: ${response.internal_notes}`);

    // Step 3: Verify response contains ONLY times (no summary repetition)
    console.log(`\n✅ [VERIFICATION] Checking response content...`);

    const responseText = response.bubbles[0].toLowerCase();

    // Should contain time slots
    expect(response.bubbles[0]).toMatch(/I pulled.*openings/i);
    expect(response.bubbles[0]).toMatch(/1\)/);
    expect(response.bubbles[0]).toMatch(/2\)/);
    expect(response.bubbles[0]).toMatch(/3\)/);
    expect(response.bubbles[0]).toMatch(/Which works best/i);

    // Should NOT contain tattoo summary
    expect(responseText).not.toContain("lion");
    expect(responseText).not.toContain("realism");
    expect(responseText).not.toContain("forearm");
    expect(responseText).not.toContain("portrait");
    expect(responseText).not.toContain(canonicalState.tattooSummary.toLowerCase());

    // Should NOT contain placement
    expect(responseText).not.toContain("right forearm");

    // Should NOT contain style
    expect(responseText).not.toContain("realism");

    // Should NOT contain any tattoo description references
    expect(responseText).not.toMatch(/your.*tattoo|your.*piece|that.*tattoo/i);

    console.log(`   ✓ Response contains time slots`);
    console.log(`   ✓ Response does NOT contain tattoo summary`);
    console.log(`   ✓ Response does NOT contain placement`);
    console.log(`   ✓ Response does NOT contain style`);
    console.log(`   ✓ Response is focused ONLY on scheduling`);

    console.log(`\n✅ Verification complete:`);
    console.log(`   ✓ Summary saved: "${canonicalState.tattooSummary}"`);
    console.log(`   ✓ Response contains: Times only`);
    console.log(`   ✓ Response excludes: Summary, placement, style, descriptions`);
    console.log("=".repeat(80));
  });

  test("response format matches expected times-only structure", async () => {
    const messageText = "what times are you available?";
    const contact = { id: "contact123" };
    const canonicalState = {
      tattooSummary: "Bouquet of flowers on left shoulder",
      tattooPlacement: "left shoulder",
      tattooStyle: "fine line",
      depositPaid: false,
    };

    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION: Times-Only Response Format");
    console.log("=".repeat(80));

    const intents = detectIntents(messageText);
    const response = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState,
      contact,
      messageText,
    });

    console.log(`\n📝 [RESPONSE] Full response:`);
    console.log(`   "${response.bubbles[0]}"`);

    // Verify structure: opening line + numbered slots + question
    const lines = response.bubbles[0].split("\n");
    console.log(`\n📊 [STRUCTURE] Response breakdown:`);
    lines.forEach((line, idx) => {
      console.log(`   Line ${idx + 1}: "${line}"`);
    });

    // Should have: opening line, 3 slot lines, blank line, question
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines[0]).toMatch(/I pulled.*openings/i);
    expect(lines[1]).toMatch(/^1\)/);
    expect(lines[2]).toMatch(/^2\)/);
    expect(lines[3]).toMatch(/^3\)/);
    expect(lines[lines.length - 1]).toMatch(/Which works best/i);

    // Verify no summary content in any line
    const allText = lines.join(" ").toLowerCase();
    expect(allText).not.toContain("bouquet");
    expect(allText).not.toContain("flowers");
    expect(allText).not.toContain("shoulder");
    expect(allText).not.toContain("fine line");

    console.log(`\n✅ Response structure verified:`);
    console.log(`   ✓ Opening line (no summary)`);
    console.log(`   ✓ Numbered time slots`);
    console.log(`   ✓ Closing question`);
    console.log(`   ✓ No summary/placement/style references`);
    console.log("=".repeat(80));
  });

  test("compares response with vs without saved summary", async () => {
    const messageText = "what times?";
    const contact = { id: "contact123" };

    console.log("\n" + "=".repeat(80));
    console.log("VERIFICATION: With vs Without Summary");
    console.log("=".repeat(80));

    // Scenario 1: No summary saved
    console.log(`\n📋 SCENARIO 1: No Summary Saved`);
    const intents1 = detectIntents(messageText);
    const response1 = await buildDeterministicResponse({
      intents: intents1,
      derivedPhase: "scheduling",
      canonicalState: {}, // No summary
      contact,
      messageText,
    });

    console.log(`   Response: "${response1.bubbles[0].substring(0, 80)}..."`);

    // Scenario 2: Summary saved
    console.log(`\n📋 SCENARIO 2: Summary Saved`);
    const intents2 = detectIntents(messageText);
    const response2 = await buildDeterministicResponse({
      intents: intents2,
      derivedPhase: "scheduling",
      canonicalState: {
        tattooSummary: "Dragon sleeve on left arm",
        tattooPlacement: "left arm",
      },
      contact,
      messageText,
    });

    console.log(`   Response: "${response2.bubbles[0].substring(0, 80)}..."`);

    // Both should be identical (times only, no summary)
    expect(response1.bubbles[0]).toBe(response2.bubbles[0]);
    expect(response1.internal_notes).toBe(response2.internal_notes);

    // Neither should contain summary
    const response1Text = response1.bubbles[0].toLowerCase();
    const response2Text = response2.bubbles[0].toLowerCase();

    expect(response1Text).not.toContain("dragon");
    expect(response2Text).not.toContain("dragon");
    expect(response1Text).not.toContain("sleeve");
    expect(response2Text).not.toContain("sleeve");

    console.log(`\n✅ Comparison:`);
    console.log(`   ✓ Responses are identical (summary doesn't affect scheduling response)`);
    console.log(`   ✓ Both contain only times`);
    console.log(`   ✓ Neither contains summary content`);
    console.log("=".repeat(80));
  });

  test("shows complete verification log", async () => {
    const messageText = "what times?";
    const contact = { id: "contact123" };
    const canonicalState = {
      tattooSummary: "Geometric mandala on back",
      tattooPlacement: "back",
      tattooStyle: "geometric",
      tattooSize: "Large",
      depositPaid: false,
    };

    console.log("\n" + "=".repeat(80));
    console.log("COMPLETE VERIFICATION LOG: Summary Saved → Times Only");
    console.log("=".repeat(80));

    console.log(`\n📊 [STATE] Saved tattoo information:`);
    console.log(`   Summary: "${canonicalState.tattooSummary}"`);
    console.log(`   Placement: "${canonicalState.tattooPlacement}"`);
    console.log(`   Style: "${canonicalState.tattooStyle}"`);
    console.log(`   Size: "${canonicalState.tattooSize}"`);

    const intents = detectIntents(messageText);
    console.log(`\n📨 [INBOUND] Message: "${messageText}"`);
    console.log(`🔍 [INTENT] Scheduling intent: ${intents.scheduling_intent}`);

    const response = await buildDeterministicResponse({
      intents,
      derivedPhase: "scheduling",
      canonicalState,
      contact,
      messageText,
    });

    console.log(`\n📝 [RESPONSE] Generated response:`);
    console.log(`   "${response.bubbles[0]}"`);

    console.log(`\n✅ [VERIFICATION] Content check:`);
    
    const responseLower = response.bubbles[0].toLowerCase();
    const summaryWords = canonicalState.tattooSummary.toLowerCase().split(" ");
    const placementWords = canonicalState.tattooPlacement.toLowerCase().split(" ");
    const styleWords = canonicalState.tattooStyle.toLowerCase().split(" ");

    let foundSummaryWords = [];
    let foundPlacementWords = [];
    let foundStyleWords = [];

    summaryWords.forEach(word => {
      if (word.length > 3 && responseLower.includes(word)) {
        foundSummaryWords.push(word);
      }
    });

    placementWords.forEach(word => {
      if (word.length > 3 && responseLower.includes(word)) {
        foundPlacementWords.push(word);
      }
    });

    styleWords.forEach(word => {
      if (word.length > 3 && responseLower.includes(word)) {
        foundStyleWords.push(word);
      }
    });

    if (foundSummaryWords.length > 0) {
      console.log(`   ⚠️ Found summary words in response: ${foundSummaryWords.join(", ")}`);
    } else {
      console.log(`   ✓ No summary words found`);
    }

    if (foundPlacementWords.length > 0) {
      console.log(`   ⚠️ Found placement words in response: ${foundPlacementWords.join(", ")}`);
    } else {
      console.log(`   ✓ No placement words found`);
    }

    if (foundStyleWords.length > 0) {
      console.log(`   ⚠️ Found style words in response: ${foundStyleWords.join(", ")}`);
    } else {
      console.log(`   ✓ No style words found`);
    }

    // Verify times are present
    const hasTimes = /\d\)/.test(response.bubbles[0]);
    console.log(`   ${hasTimes ? "✓" : "✗"} Time slots present: ${hasTimes}`);

    console.log(`\n✅ Final verification:`);
    console.log(`   ✓ Response contains ONLY times`);
    console.log(`   ✓ Response excludes saved summary/placement/style`);
    console.log("=".repeat(80));

    expect(foundSummaryWords.length).toBe(0);
    expect(foundPlacementWords.length).toBe(0);
    expect(foundStyleWords.length).toBe(0);
    expect(hasTimes).toBe(true);
  });
});






