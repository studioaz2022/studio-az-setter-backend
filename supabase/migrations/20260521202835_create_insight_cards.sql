-- insight_cards — Stats Dashboard Insight Loop storage.
--
-- An "insight card" is a Claude-generated reading of one anomaly in the
-- analytics data. Each card has a one-line headline + 3 ranked hypotheses
-- about why the anomaly is happening. Cards flow through a small workflow:
-- open → acknowledged → shipped → verified (or closed).
--
-- The generator runs weekly via Render cron. Manual runs are also supported
-- via POST /api/seo/dashboard/insights/:site/generate for ops debugging.
--
-- Cards aren't deleted — resolved cards stay viewable in the History section
-- of the Insights page so the improvement story is preserved over time.

CREATE TABLE IF NOT EXISTS insight_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which site this insight is about. "tattoo" for v1; "barbershop" later.
  site TEXT NOT NULL,

  -- One-line summary of the anomaly, written by the generator and shown as the
  -- card title. e.g. "Consultation submits +500% week-over-week (6 vs 1)"
  headline TEXT NOT NULL,

  -- Three ranked hypotheses, each an object { text, confidence }.
  -- Stored as JSONB so the LLM can return arbitrary structure if needed later.
  hypotheses JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Severity bucket so the UI can sort/color cards. The generator picks one of:
  --   "attention"  — biggest swings, |delta| > 100% or cliff-class drops
  --   "noteworthy" — moderate swings, 50% < |delta| <= 100%
  --   "context"    — informational, surfaced for full picture
  severity TEXT NOT NULL DEFAULT 'noteworthy',

  -- The underlying metric this card is about (e.g. "consultation_submitted").
  -- Used to dedup repeat detections of the same anomaly during the same week.
  metric_key TEXT NOT NULL,

  -- Snapshot of the metric values when the card was generated, so we can
  -- show "what was true" even if the underlying data window moves.
  current_value NUMERIC,
  prior_value NUMERIC,
  delta NUMERIC,   -- signed fractional delta (e.g. 5.0 for +500%, -0.58 for cliff)

  -- Workflow state:
  --   "open"         — newly generated, awaiting acknowledgment
  --   "acknowledged" — Lionel has seen it
  --   "shipped"      — a fix was deployed in response
  --   "verified"     — post-fix metrics confirm the fix worked
  --   "dismissed"    — false positive or not actionable
  status TEXT NOT NULL DEFAULT 'open',

  -- Free-text notes from Lionel (e.g. why dismissed, or what fix shipped).
  notes TEXT,

  -- Timestamps for each state transition. Null until the transition happens.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  shipped_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);

-- Hot paths:
--   1. List active cards for one site, newest first
--   2. List resolved cards for one site, newest first (history)
--   3. Dedup: was there an open card for this metric_key + site this week?
CREATE INDEX IF NOT EXISTS insight_cards_site_status_created_idx
  ON insight_cards (site, status, created_at DESC);

CREATE INDEX IF NOT EXISTS insight_cards_site_metric_created_idx
  ON insight_cards (site, metric_key, created_at DESC);
