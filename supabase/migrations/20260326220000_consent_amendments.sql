-- Phase 6: Consent Form Updates & Amendments
-- Adds expired_at/superseded_by to consent_forms, creates consent_amendments and consent_form_changes tables

-- 1. Add columns to consent_forms for tracking expired/superseded forms
ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE consent_forms ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES consent_forms(id);

-- 2. Consent amendments table — separate signed amendments to completed consent forms
CREATE TABLE IF NOT EXISTS consent_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_form_id uuid NOT NULL REFERENCES consent_forms(id),
  contact_id text NOT NULL,

  -- What changed (one row per amendment, can have multiple field changes)
  changes jsonb NOT NULL,  -- [{ field: "tattoo_placement", old: "Left forearm", new: "Right forearm" }]

  -- Secure link
  token text UNIQUE NOT NULL,

  -- E-signature evidence package
  signature_data text,
  signed_at timestamptz,
  signer_ip text,
  signer_user_agent text,
  legal_text_hash text,

  -- Status
  status text DEFAULT 'sent',  -- sent / completed
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_amendments_consent_form ON consent_amendments(consent_form_id);
CREATE INDEX IF NOT EXISTS idx_consent_amendments_contact ON consent_amendments(contact_id);
CREATE INDEX IF NOT EXISTS idx_consent_amendments_token ON consent_amendments(token);

-- 3. Consent form changes table — audit trail for unsigned form updates
CREATE TABLE IF NOT EXISTS consent_form_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_form_id uuid NOT NULL REFERENCES consent_forms(id),
  changes jsonb NOT NULL,  -- [{ field: "tattoo_placement", old: "Left forearm", new: "Right forearm" }]
  changed_by text,         -- artist name or userId
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_form_changes_form ON consent_form_changes(consent_form_id);
