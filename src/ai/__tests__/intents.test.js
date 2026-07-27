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

  // `translator_affirm_intent` was deliberately removed (intents.js:28/149) —
  // a translator is now implied by the slot the lead selects rather than by a
  // separate affirmation turn. This guards against it being reintroduced as an
  // intent, which would resurrect the duplicate handlers.
  test("translator_affirm_intent is not part of the intent contract", () => {
    for (const translatorNeeded of [true, false]) {
      const intents = detectIntents("Yes that works", {
        consultationType: "appointment",
        translatorNeeded,
      });
      expect(intents).not.toHaveProperty("translator_affirm_intent");
    }
  });

  test("a translator mention routes to the consult-path branch", () => {
    // `/\btranslator\b/` is a consult-path pattern, not a price/process one:
    // the deterministic handler answers translator questions from that branch
    // (deterministicResponses.js:606) while it explains the video-call option.
    const intents = detectIntents("Will there be a translator on the call?", {});
    expect(intents.consult_path_choice_intent).toBe(true);
  });
});
