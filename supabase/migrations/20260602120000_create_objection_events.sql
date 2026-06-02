-- objection_events — Phase 3 log of every objection the v2 AI setter detects.
--
-- Append-only. Written when the escalation layer flags an objection in the lead's message.
-- Drives the Phase 6 tuning checkpoint: for each row, was the right objection detected, did
-- the reply land or feel canned, did the lead progress or fall off?
--
-- `outcome` is backfilled later (deposit_paid | went_cold | human_took_over) by a separate
-- job once we can join to the deposit/funnel state. Until then it stays null.
--
-- ⚠️ NOT YET APPLIED as of authoring — pending approval. The writer (objectionStore.js) is a
-- graceful no-op until this table exists, so shipping the code before applying is safe.

CREATE TABLE IF NOT EXISTS objection_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  contact_id TEXT,            -- GHL contact id (the "lead id")
  contact_name TEXT,          -- best-effort display name at the time
  objection_id TEXT,          -- one of the 10 objection ids (price_too_high, need_to_think, ...)
  escalation_reason TEXT,     -- why we escalated (e.g. "objection:price_too_high+circling")
  message_text TEXT,          -- the lead's exact message that triggered detection
  bot_reply TEXT,             -- what the bot replied
  model_used TEXT,            -- claude-haiku-4-5-* | claude-sonnet-4-6
  language TEXT,              -- en | es
  outcome TEXT                -- backfilled later: deposit_paid | went_cold | human_took_over
);

-- Hot paths for the tuning review:
--   1. Newest first (scroll the log)
--   2. All events for one objection type, newest first ("show me every price objection")
--   3. All events for one contact (reconstruct a lead's objection arc)
CREATE INDEX IF NOT EXISTS objection_events_created_idx
  ON objection_events (created_at DESC);

CREATE INDEX IF NOT EXISTS objection_events_objection_created_idx
  ON objection_events (objection_id, created_at DESC);

CREATE INDEX IF NOT EXISTS objection_events_contact_idx
  ON objection_events (contact_id);
