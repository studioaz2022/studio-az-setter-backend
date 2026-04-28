-- fill_tokens table — pre-loaded consultation flow
-- Maps a short opaque token (sent to lead via SMS link) to the GHL contact + artist context
-- so the public fill page can resolve the token, prefill the form, and accept submission.
--
-- See FILL_FLOW_PLAN.md Phase 1 + Phase 4.5 for full schema rationale.

CREATE TABLE IF NOT EXISTS fill_tokens (
  token                    text PRIMARY KEY,
  contact_id               text NOT NULL,
  artist_slug              text NOT NULL,
  language                 text DEFAULT 'en',
  source                   text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  last_seen_at             timestamptz,
  first_step_completed_at  timestamptz,
  last_step_completed_at   timestamptz,
  submitted_at             timestamptz,
  nudge_sent_at            timestamptz
);

-- Idempotent indexes
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_fill_tokens_contact') THEN
    CREATE INDEX idx_fill_tokens_contact ON fill_tokens(contact_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_fill_tokens_expires') THEN
    -- Partial index: only un-submitted tokens need expiry sweep
    CREATE INDEX idx_fill_tokens_expires ON fill_tokens(expires_at) WHERE submitted_at IS NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_fill_tokens_created') THEN
    CREATE INDEX idx_fill_tokens_created ON fill_tokens(created_at DESC);
  END IF;
END$$;
