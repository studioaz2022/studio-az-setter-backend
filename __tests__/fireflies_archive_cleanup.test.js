// fireflies_archive_cleanup.test.js
//
// Guards the one rule that makes reclaiming Fireflies storage safe:
// NEVER delete a transcript we do not hold a copy of.
//
// Fireflies caps storage in minutes and the account is full, so meetings must
// be deleted. Every consultation used to live in exactly one place — a GHL
// custom field that the client's *next* consultation overwrote — and 17 of the
// account's 50 meetings had no copy anywhere at all. A cleanup that cannot tell
// "archived" from "unarchived" permanently destroys client conversations, so
// that distinction is worth a test rather than a comment.

const mockDeleted = [];

jest.mock("../src/clients/firefliesClient", () => ({
  batchDeleteTranscripts: jest.fn(async (ids) => {
    mockDeleted.push(...ids);
    return ids.length;
  }),
}));

// Purpose-built stub for exactly the chains firefliesCleanup uses:
//   .select(cols).in(col, vals).not(col,"is",null).lt(col, val)
//   .select(cols, {count,head}).is(col, null).lt(col, val)
//   .update(patch).in(col, ids)
let mockRows = [];
let mockUpdates = [];

function mockMakeQuery(table) {
  const preds = [];
  let headCount = false;
  const q = {
    select: (_cols, opts) => {
      if (opts && opts.head) headCount = true;
      return q;
    },
    in: (col, vals) => {
      preds.push((r) => vals.includes(r[col]));
      return q;
    },
    not: (col, _op, _v) => {
      preds.push((r) => r[col] !== null && r[col] !== undefined);
      return q;
    },
    is: (col, _v) => {
      preds.push((r) => r[col] === null || r[col] === undefined);
      return q;
    },
    lt: (col, val) => {
      preds.push((r) => r[col] && r[col] < val);
      return q;
    },
    update: (patch) => {
      q.__patch = patch;
      return q;
    },
    then: undefined,
  };
  // Chains are awaited directly, so resolve on await.
  q.then = (resolve) => {
    const matched = mockRows.filter((r) => preds.every((p) => p(r)));
    if (q.__patch) {
      mockUpdates.push({ patch: q.__patch, ids: matched.map((r) => r.transcript_id) });
      return resolve({ error: null });
    }
    if (headCount) return resolve({ count: matched.length, error: null });
    return resolve({ data: matched, error: null });
  };
  return q;
}

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t) => mockMakeQuery(t) }),
}));

const OLD = "2026-01-01T00:00:00.000Z"; // well past any retention window
const NEW = new Date().toISOString(); // inside the window

describe("Fireflies cleanup — archived-only invariant", () => {
  let runCleanupSweep;

  beforeEach(() => {
    jest.resetModules();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    mockDeleted.length = 0;
    mockUpdates = [];
    ({ runCleanupSweep } = require("../src/services/firefliesCleanup"));
  });

  test("deletes an old meeting whose transcript we hold", async () => {
    mockRows = [
      {
        transcript_id: "archived-old",
        status: "processed",
        meeting_date: OLD,
        transcript_text: "Speaker (00:00:00): hello",
        duration_minutes: 20,
      },
    ];

    const result = await runCleanupSweep();

    expect(result.success).toBe(true);
    expect(mockDeleted).toEqual(["archived-old"]);
    expect(result.minutesReclaimed).toBe(20);
  });

  test("NEVER deletes a meeting we have no copy of, however old", async () => {
    mockRows = [
      {
        transcript_id: "orphan-only-in-fireflies",
        status: "processed",
        meeting_date: OLD,
        transcript_text: null, // never archived — the only copy is upstream
        duration_minutes: 15,
      },
    ];

    const result = await runCleanupSweep();

    expect(mockDeleted).toEqual([]);
    expect(result.deleted).toBe(0);
    // and it must say so, so a stalled backfill is visible
    expect(result.skippedUnarchived).toBe(1);
  });

  test("leaves recent meetings alone even when archived", async () => {
    mockRows = [
      {
        transcript_id: "archived-recent",
        status: "processed",
        meeting_date: NEW,
        transcript_text: "words",
        duration_minutes: 10,
      },
    ];

    await runCleanupSweep();

    expect(mockDeleted).toEqual([]);
  });

  test("dry run reports without deleting", async () => {
    mockRows = [
      {
        transcript_id: "archived-old",
        status: "processed",
        meeting_date: OLD,
        transcript_text: "words",
        duration_minutes: 30,
      },
    ];

    const result = await runCleanupSweep({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.eligible).toBe(1);
    expect(result.minutesReclaimable).toBe(30);
    expect(mockDeleted).toEqual([]);
  });

  test("mixed batch deletes only the archived half", async () => {
    mockRows = [
      { transcript_id: "safe-1", status: "processed", meeting_date: OLD, transcript_text: "a", duration_minutes: 5 },
      { transcript_id: "orphan-1", status: "processed", meeting_date: OLD, transcript_text: null, duration_minutes: 5 },
      { transcript_id: "safe-2", status: "unmatched", meeting_date: OLD, transcript_text: "b", duration_minutes: 5 },
    ];

    const result = await runCleanupSweep();

    expect(mockDeleted.sort()).toEqual(["safe-1", "safe-2"]);
    expect(result.skippedUnarchived).toBe(1);
  });

  test("marks deleted rows rather than dropping them", async () => {
    mockRows = [
      { transcript_id: "archived-old", status: "processed", meeting_date: OLD, transcript_text: "w", duration_minutes: 5 },
    ];

    await runCleanupSweep();

    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].patch.status).toBe("deleted");
    expect(mockUpdates[0].patch.deleted_at).toBeTruthy();
  });
});

describe("Fireflies archive — a second consult must not erase the first", () => {
  let archiveConsultation;
  let createNote;
  let updateContact;

  beforeEach(() => {
    jest.resetModules();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    mockRows = [];
    mockUpdates = [];

    createNote = jest.fn(async () => ({ note: { id: "note_123" } }));
    updateContact = jest.fn(async () => ({}));

    jest.doMock("../src/clients/ghlSdk", () => ({ ghl: { contacts: { createNote } } }));
    jest.doMock("../src/clients/ghlClient", () => ({ updateContact }));

    // upsert/update chains used by the archive service
    jest.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: () => ({
          upsert: async (row) => {
            mockRows.push(row);
            return { error: null };
          },
          update: () => ({ eq: async () => ({ error: null }) }),
        }),
      }),
    }));

    ({ archiveConsultation } = require("../src/services/firefliesArchive"));
  });

  const consult = (id, date) => ({
    transcript: { id, title: `Online Consultation: Repeat Client`, date, duration: 18 },
    rawText: `Client (00:00:00): consult ${id}`,
    summaryText: `summary ${id}`,
    contactId: "contact_repeat",
    clientName: "Repeat Client",
  });

  test("two consults for one contact produce two archive rows and two notes", async () => {
    await archiveConsultation(consult("first", Date.now() - 86400000));
    await archiveConsultation(consult("second", Date.now()));

    // Both survive independently — this is what the custom fields could not do.
    expect(mockRows).toHaveLength(2);
    expect(mockRows.map((r) => r.transcript_id).sort()).toEqual(["first", "second"]);
    expect(mockRows[0].transcript_text).toContain("consult first");
    expect(mockRows[1].transcript_text).toContain("consult second");

    // One note each — notes are unlimited per contact and never overwrite.
    expect(createNote).toHaveBeenCalledTimes(2);
  });

  test("backfill of an old consult does not touch the latest-consult fields", async () => {
    await archiveConsultation({ ...consult("old", 1700000000000), updateFields: false });

    expect(mockRows).toHaveLength(1);
    expect(createNote).toHaveBeenCalledTimes(1);
    // A six-month-old consult must not displace the client's current one.
    expect(updateContact).not.toHaveBeenCalled();
  });

  test("an unmatched transcript is still archived", async () => {
    const res = await archiveConsultation({
      transcript: { id: "unmatched-1", title: "Tattoo Consultation", date: Date.now(), duration: 12 },
      rawText: "Someone (00:00:00): hello",
      status: "unmatched",
    });

    expect(res.supabase).toBe(true);
    expect(mockRows[0].transcript_text).toBeTruthy();
    expect(mockRows[0].archived_at).toBeTruthy();
    expect(createNote).not.toHaveBeenCalled(); // no contact to attach it to
  });

  test("a GHL failure still leaves the Supabase archive intact", async () => {
    createNote.mockRejectedValueOnce(new Error("GHL 500"));
    updateContact.mockRejectedValueOnce(new Error("GHL 500"));

    const res = await archiveConsultation(consult("resilient", Date.now()));

    expect(res.supabase).toBe(true);
    expect(mockRows[0].transcript_text).toContain("consult resilient");
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
