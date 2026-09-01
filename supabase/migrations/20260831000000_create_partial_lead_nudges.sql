-- Partial-lead nudge ledger.
--
-- /lead/partial fires on the contact-details step of the consultation widget —
-- we have a name and a phone number, but not the tattoo idea yet. Most people
-- finish within a minute or two. The ones who DON'T are the whole point: a
-- stranger handed us their number and then walked away, and nobody was told.
--
-- One row per contact, written at partial and stamped at final. The loop reads
-- this instead of searching GHL by source so the nudge can't be lost to search
-- pagination or a contact being edited between the two submissions.
--
-- Server-only table (service-role access) — no RLS, per repo convention.
CREATE TABLE IF NOT EXISTS partial_lead_nudges (
  contact_id   TEXT PRIMARY KEY,
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  location_id  TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Claim column. Stamped BEFORE the task is raised so a crash mid-send costs
  -- one nudge rather than raising a duplicate on the next tick.
  nudged_at    TIMESTAMPTZ,
  -- Stamped when /lead/final lands for this contact. A row with this set is
  -- a completed form and must never be nudged.
  completed_at TIMESTAMPTZ
);

-- The loop's only query: unnudged, uncompleted, inside the age window.
CREATE INDEX IF NOT EXISTS idx_partial_lead_nudges_pending
  ON partial_lead_nudges (created_at)
  WHERE nudged_at IS NULL AND completed_at IS NULL;
