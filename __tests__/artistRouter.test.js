const { refreshArtistWorkloads } = require("../src/ai/artistRouter");
const { ARTIST_ASSIGNED_USER_IDS, OPPORTUNITY_STAGES } = require("../src/config/constants");
const { PIPELINE_STAGE_CONFIG } = require("../src/config/pipelineConfig");

jest.mock("../src/clients/ghlClient", () => ({
  getContact: jest.fn(),
  updateSystemFields: jest.fn(),
  updateTattooFields: jest.fn(),
}));

jest.mock("../src/clients/ghlOpportunityClient", () => ({
  searchOpportunities: jest.fn(),
}));

const { searchOpportunities } = require("../src/clients/ghlOpportunityClient");

/**
 * refreshArtistWorkloads queries GHL once per unique artist user id
 * (`query.assigned_to`) and scores each returned opportunity by its pipeline
 * stage: CONSULT_MESSAGE=1, CONSULT_APPOINTMENT=2, TATTOO_BOOKED=3.
 * Opportunities created outside the attribution window are skipped.
 */
describe("refreshArtistWorkloads", () => {
  const stageIdFor = (stageKey) => PIPELINE_STAGE_CONFIG[stageKey].id;
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  /** Routes mocked opportunities by the artist user id being queried. */
  function opportunitiesByArtist(byUserId) {
    searchOpportunities.mockImplementation(({ query }) =>
      Promise.resolve(byUserId[query.assigned_to] || [])
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("sums stage scores per artist", async () => {
    opportunitiesByArtist({
      [ARTIST_ASSIGNED_USER_IDS.JOAN]: [
        { id: "msg-1", pipelineStageId: stageIdFor(OPPORTUNITY_STAGES.CONSULT_MESSAGE), createdAt: daysAgo(1) },
      ],
      [ARTIST_ASSIGNED_USER_IDS.ANDREW]: [
        { id: "appt-1", pipelineStageId: stageIdFor(OPPORTUNITY_STAGES.CONSULT_APPOINTMENT), createdAt: daysAgo(2) },
        { id: "tattoo-1", pipelineStageId: stageIdFor(OPPORTUNITY_STAGES.TATTOO_BOOKED), createdAt: daysAgo(3) },
      ],
    });

    const scores = await refreshArtistWorkloads({ force: true });

    expect(scores.Joan).toBe(1); // one message consult
    expect(scores.Andrew).toBe(5); // 2 (appointment) + 3 (tattoo booked)
  });

  it("queries once per unique artist user id, keyed on assigned_to", async () => {
    opportunitiesByArtist({});
    await refreshArtistWorkloads({ force: true });

    const uniqueIds = [...new Set(Object.values(ARTIST_ASSIGNED_USER_IDS))];
    expect(searchOpportunities).toHaveBeenCalledTimes(uniqueIds.length);
    for (const id of uniqueIds) {
      expect(searchOpportunities).toHaveBeenCalledWith({ query: { assigned_to: id } });
    }
  });

  it("ignores opportunities older than the attribution window", async () => {
    opportunitiesByArtist({
      [ARTIST_ASSIGNED_USER_IDS.JOAN]: [
        { id: "recent", pipelineStageId: stageIdFor(OPPORTUNITY_STAGES.TATTOO_BOOKED), createdAt: daysAgo(5) },
        { id: "stale", pipelineStageId: stageIdFor(OPPORTUNITY_STAGES.TATTOO_BOOKED), createdAt: daysAgo(90) },
      ],
    });

    const scores = await refreshArtistWorkloads({ force: true, windowDays: 30 });
    expect(scores.Joan).toBe(3); // only the recent one counts
  });

  it("accepts dateAdded as an alias for createdAt", async () => {
    opportunitiesByArtist({
      [ARTIST_ASSIGNED_USER_IDS.JOAN]: [
        { id: "legacy", pipelineStageId: stageIdFor(OPPORTUNITY_STAGES.CONSULT_APPOINTMENT), dateAdded: daysAgo(1) },
      ],
    });

    const scores = await refreshArtistWorkloads({ force: true });
    expect(scores.Joan).toBe(2);
  });

  it("scores nothing for stages outside the tracked three", async () => {
    opportunitiesByArtist({
      [ARTIST_ASSIGNED_USER_IDS.JOAN]: [
        { id: "intake", pipelineStageId: stageIdFor(OPPORTUNITY_STAGES.INTAKE), createdAt: daysAgo(1) },
        { id: "lost", pipelineStageId: stageIdFor(OPPORTUNITY_STAGES.COLD_NURTURE_LOST), createdAt: daysAgo(1) },
      ],
    });

    const scores = await refreshArtistWorkloads({ force: true });
    expect(scores.Joan).toBe(0);
  });

  it("starts every tracked artist at zero and survives a failed artist query", async () => {
    searchOpportunities.mockImplementation(({ query }) =>
      query.assigned_to === ARTIST_ASSIGNED_USER_IDS.JOAN
        ? Promise.reject(new Error("GHL 500"))
        : Promise.resolve([
            { id: "a", pipelineStageId: stageIdFor(OPPORTUNITY_STAGES.CONSULT_MESSAGE), createdAt: daysAgo(1) },
          ])
    );

    const scores = await refreshArtistWorkloads({ force: true });

    // One artist's outage must not zero out or abort the whole refresh.
    expect(scores.Joan).toBe(0);
    expect(scores.Andrew).toBe(1);
  });
});
