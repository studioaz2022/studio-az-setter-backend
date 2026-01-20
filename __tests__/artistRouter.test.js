const { refreshArtistWorkloads } = require("../src/ai/artistRouter");
const { ARTIST_ASSIGNED_USER_IDS, OPPORTUNITY_STAGES } = require("../src/config/constants");
const { PIPELINE_STAGE_CONFIG } = require("../src/config/pipelineConfig");

jest.mock("../ghlClient", () => ({
  getContact: jest.fn(),
  updateSystemFields: jest.fn(),
  updateTattooFields: jest.fn(),
}));

jest.mock("../src/clients/ghlOpportunityClient", () => ({
  searchOpportunities: jest.fn(),
}));

const { searchOpportunities } = require("../src/clients/ghlOpportunityClient");
const { getContact } = require("../src/clients/ghlClient");

describe("refreshArtistWorkloads", () => {
  const stageIdFor = (stageKey) => PIPELINE_STAGE_CONFIG[stageKey].id;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("aggregates workload scores across consult and tattoo stages", async () => {
    searchOpportunities.mockImplementation(({ query }) => {
      switch (query.pipelineStageId) {
        case stageIdFor(OPPORTUNITY_STAGES.CONSULT_MESSAGE):
          return Promise.resolve([
            { id: "msg-1", assignedUserId: ARTIST_ASSIGNED_USER_IDS.JOAN },
          ]);
        case stageIdFor(OPPORTUNITY_STAGES.CONSULT_APPOINTMENT):
          return Promise.resolve([
            { id: "appt-1", assignedUserId: ARTIST_ASSIGNED_USER_IDS.ANDREW },
            { id: "appt-2", contactId: "contact-consult" },
          ]);
        case stageIdFor(OPPORTUNITY_STAGES.TATTOO_BOOKED):
          return Promise.resolve([
            { id: "tattoo-1", assignedUserId: ARTIST_ASSIGNED_USER_IDS.ANDREW },
          ]);
        default:
          return Promise.resolve([]);
      }
    });

    getContact.mockResolvedValue({
      customField: {
        inquired_technician: "Joan",
      },
    });

    const scores = await refreshArtistWorkloads({ force: true });

    expect(scores.Joan).toBe(3); // 1 (message) + 2 (appt fallback)
    expect(scores.Andrew).toBe(5); // 2 (appt) + 3 (tattoo booked)

    expect(getContact).toHaveBeenCalledWith("contact-consult");
    expect(searchOpportunities).toHaveBeenCalledTimes(3);
  });
});

