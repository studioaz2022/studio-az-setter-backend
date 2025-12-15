jest.mock("../aiClient", () => ({
  generateOpenerForContact: jest.fn().mockResolvedValue({
    language: "en",
    bubbles: [],
    internal_notes: "",
    meta: {},
    field_updates: {},
  }),
}));

jest.mock("../deterministicResponses", () => ({
  buildDeterministicResponse: jest.fn().mockResolvedValue({
    language: "en",
    bubbles: ["deterministic"],
    internal_notes: "deterministic",
    meta: {},
    field_updates: {},
  }),
}));

jest.mock("../consultPathHandler", () => ({
  handlePathChoice: jest.fn().mockResolvedValue({}),
}));

jest.mock("../holdLifecycle", () => ({
  evaluateHoldState: jest.fn().mockResolvedValue(),
}));

jest.mock("../../ghlClient", () => ({
  updateSystemFields: jest.fn().mockResolvedValue(),
  sendConversationMessage: jest.fn().mockResolvedValue(),
}));

const { handleInboundMessage } = require("../controller");
const { generateOpenerForContact } = require("../aiClient");
const { buildDeterministicResponse } = require("../deterministicResponses");

describe("handleInboundMessage routing order", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("skips LLM when hard-skip scheduling intent is detected", async () => {
    const contact = {
      id: "contact_1",
      customField: {
        tattoo_summary: "lion",
        tattoo_placement: "forearm",
        tattoo_size: "6x3",
      },
    };

    const result = await handleInboundMessage({
      contact,
      aiPhase: null,
      leadTemperature: null,
      latestMessageText: "what times do you have this week?",
    });

    expect(generateOpenerForContact).not.toHaveBeenCalled();
    expect(buildDeterministicResponse).toHaveBeenCalledTimes(1);
    expect(result.routing.selected_handler).toBe("deterministic");
  });
});

