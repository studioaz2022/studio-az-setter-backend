const { detectIntents } = require("../intents");

describe("detectIntents", () => {
  test("scheduling intent on availability question", () => {
    const intents = detectIntents("What times are you available this week?");
    expect(intents.scheduling_intent).toBe(true);
    expect(intents.consult_path_choice_intent).toBe(false);
  });

  test("multi-intent: video choice + scheduling", () => {
    const intents = detectIntents("Video call this week—what times?");
    expect(intents.consult_path_choice_intent).toBe(true);
    expect(intents.scheduling_intent).toBe(true);
  });

  test("slot selection via option number", () => {
    const intents = detectIntents("Option 2 works");
    expect(intents.slot_selection_intent).toBe(true);
  });

  test("deposit intent detection", () => {
    const intents = detectIntents("Send me the deposit link, I'm ready to pay now.");
    expect(intents.deposit_intent).toBe(true);
  });

  test("reschedule intent detection", () => {
    const intents = detectIntents("Can we move to another day?");
    expect(intents.reschedule_intent).toBe(true);
  });

  test("cancel intent detection", () => {
    const intents = detectIntents("I need to cancel my appointment.");
    expect(intents.cancel_intent).toBe(true);
  });

  test("artist-guided size intent detection", () => {
    const intents = detectIntents("Not sure on size, whatever you think.");
    expect(intents.artist_guided_size_intent).toBe(true);
  });

  test("process and price question intent", () => {
    const intents = detectIntents("What's the price and how does the process work?");
    expect(intents.process_or_price_question_intent).toBe(true);
  });

  test("translator affirmation requires translator_needed=true", () => {
    const canonicalState = { consultationType: "appointment", translatorNeeded: false };
    const intents = detectIntents("Yes that works", canonicalState);
    expect(intents.translator_affirm_intent).toBe(false);
  });

  test("translator affirmation fires only when translator_needed=true", () => {
    const canonicalState = { consultationType: "appointment", translatorNeeded: true };
    const intents = detectIntents("Yes that works", canonicalState);
    expect(intents.translator_affirm_intent).toBe(true);
    expect(intents.scheduling_intent).toBe(true);
  });
});
