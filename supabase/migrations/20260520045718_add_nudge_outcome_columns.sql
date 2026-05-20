-- Separate "row processed by nudge sweep" from "nudge SMS actually sent."
--
-- Background: nudge_sent_at was being stamped in 5 different code paths in
-- fillNudgeService.processTokenRow, only one of which dispatched an SMS. This
-- made nudges_sent in the funnel snapshot meaningless (GHL conversation history
-- confirms zero nudge bodies have ever been sent, but 4 historical rows have
-- nudge_sent_at populated).
--
-- New columns:
--   nudge_outcome     — which branch of processTokenRow resolved this row
--                       (sent | skipped_engaged | skipped_replied |
--                       skipped_contact | skipped_unknown_artist | unknown_legacy)
--   nudge_sms_sent_at — only set when an SMS was actually dispatched to GHL
--
-- nudge_sent_at is kept for backwards compatibility but is now deprecated.
-- Future code should use nudge_outcome / nudge_sms_sent_at.

ALTER TABLE fill_tokens
  ADD COLUMN IF NOT EXISTS nudge_outcome TEXT,
  ADD COLUMN IF NOT EXISTS nudge_sms_sent_at TIMESTAMPTZ;

-- Backfill historical rows: stamp existed but we can't reconstruct which path
-- fired it without logs that no longer exist. Honest tag is "unknown_legacy."
UPDATE fill_tokens
SET nudge_outcome = 'unknown_legacy'
WHERE nudge_sent_at IS NOT NULL
  AND nudge_outcome IS NULL;

-- Helps the funnel snapshot's nudge_sms_sent count and the nudge sweep's
-- already-processed filter.
CREATE INDEX IF NOT EXISTS fill_tokens_nudge_sms_sent_at_idx
  ON fill_tokens (nudge_sms_sent_at)
  WHERE nudge_sms_sent_at IS NOT NULL;
