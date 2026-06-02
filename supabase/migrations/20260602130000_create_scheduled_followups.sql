-- scheduled_followups — Phase 4 future-dated touch-back reminders for the v2 AI setter.
--
-- When a lead goes cold or asks for time, the bot schedules a follow-up here instead of pinging
-- repeatedly. A cron sweep (processDueFollowups) sends them when due. Cadence is 2d / 7d / 21d
-- then drop. The reopening message is LLM-drafted to reference what the lead actually said.
--
-- Inbound-only philosophy still holds: these are touch-backs on an EXISTING conversation the
-- lead started — never cold outreach.
--
-- ⚠️ NOT YET APPLIED as of authoring — pending approval. followupScheduler.js no-ops until the
-- table exists, so shipping the code first is safe.

CREATE TABLE IF NOT EXISTS scheduled_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  contact_id TEXT NOT NULL,          -- GHL contact to follow up with
  scheduled_for TIMESTAMPTZ NOT NULL, -- when the follow-up should send
  message TEXT NOT NULL,             -- the drafted reopening message
  cadence_step SMALLINT DEFAULT 1,   -- 1 = +2d, 2 = +7d, 3 = +21d, then drop
  reason TEXT,                       -- why scheduled (e.g. "lead asked for time to think")
  drafted_by_model TEXT,             -- which model drafted the message

  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | cancelled
  sent_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT                 -- e.g. "lead replied" | "deposit paid" | "human took over"
);

-- Hot paths:
--   1. Cron: due + pending, oldest first
--   2. All follow-ups for one contact (cancel them when the lead re-engages)
CREATE INDEX IF NOT EXISTS scheduled_followups_due_idx
  ON scheduled_followups (status, scheduled_for);

CREATE INDEX IF NOT EXISTS scheduled_followups_contact_idx
  ON scheduled_followups (contact_id, status);
