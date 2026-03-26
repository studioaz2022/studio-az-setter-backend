-- Ensure consent_forms table has all required columns
-- Table may already exist from a previous migration; add missing columns safely.

-- E-signature audit trail columns
ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signed_at timestamptz;
ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signer_ip text;
ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS signer_user_agent text;
ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS legal_text_hash text;

-- Day-of reminder tracking
ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS day_of_reminder_sent boolean DEFAULT false;

-- Indexes (IF NOT EXISTS not supported for all index types, use DO block)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_consent_forms_date_of_procedure') THEN
    CREATE INDEX idx_consent_forms_date_of_procedure ON consent_forms(date_of_procedure);
  END IF;
END$$;
