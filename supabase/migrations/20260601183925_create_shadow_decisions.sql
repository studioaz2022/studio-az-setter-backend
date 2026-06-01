-- shadow_decisions — Phase 0.5 shadow-mode log for the v2 AI-setter funnel gate.
--
-- While the v2 funnel gate runs in shadow mode (AI_BOT_SHADOW=true), it changes
-- nothing about the live v1 bot. For every inbound tattoo message it records what
-- it WOULD have decided here, so we can audit it against real traffic before it
-- ever drives behavior:
--   "show me every message we WOULD have marked not_a_lead — were any real leads?"
--   "what % of new contacts did the classifier call high vs medium vs low?"
--
-- Rows are never updated — this is an append-only decision log. Safe to truncate
-- once v2 is live and tuned. No PII beyond what GHL already stores.

CREATE TABLE IF NOT EXISTS shadow_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Who / where
  contact_id TEXT,                 -- GHL contact id
  contact_name TEXT,               -- best-effort display name at decision time
  location_id TEXT,                -- GHL location id off the webhook payload
  location_reason TEXT,            -- tattoo | barbershop | unknown_location | missing_env
  entry_source TEXT,               -- sms | dm | whatsapp | unknown

  -- What the lead said
  message_text TEXT,               -- combined/debounced inbound text at decision time

  -- Gate state + decision
  shadow_stage TEXT,               -- "location" (exited at first gate) | "funnel"
  funnel_status_current TEXT,      -- funnel_status when seen (null/empty => brand-new/unset)
  action TEXT,                     -- exit | proceed | enroll_engage | enroll_engage_notify
                                   --   | mark_not_a_lead | silent | reclassify
  notify_human BOOLEAN DEFAULT false,
  reason TEXT,                     -- human-readable why
  ran_classifier BOOLEAN DEFAULT false,

  -- Classifier output (null when classifier didn't run). Shape:
  --   { is_tattoo_lead, confidence, reasoning, language, _error? }
  classifier JSONB,

  -- Field mutations live mode WOULD have applied (funnel_status, entry source/date, language).
  proposed JSONB
);

-- Hot paths for review/tuning:
--   1. Newest decisions first (general scroll)
--   2. Filter by action (e.g. audit every mark_not_a_lead), newest first
--   3. All decisions for one contact
CREATE INDEX IF NOT EXISTS shadow_decisions_created_idx
  ON shadow_decisions (created_at DESC);

CREATE INDEX IF NOT EXISTS shadow_decisions_action_created_idx
  ON shadow_decisions (action, created_at DESC);

CREATE INDEX IF NOT EXISTS shadow_decisions_contact_idx
  ON shadow_decisions (contact_id);
