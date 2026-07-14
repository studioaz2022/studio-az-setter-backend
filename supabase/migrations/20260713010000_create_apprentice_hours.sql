-- Create apprentice_hours table
-- Minnesota body-art apprentice licensure hour log (Pillar 4 of APPRENTICE_ONBOARDING_PLAN.md).
-- Megan (apprentice under Andrew) self-logs supervised hours toward the state's 200-hour requirement.
-- This is the highest-stakes data in the feature — it goes to the state. Privacy-scoped:
-- visible to the apprentice (their own rows) and owner/admin only. NOT to peer artists (Andrew).

-- ============================================
-- Apprentice Hours Table
-- ============================================

CREATE TABLE IF NOT EXISTS apprentice_hours (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Who the hours belong to, and their supervising mentor
    apprentice_ghl_id TEXT NOT NULL,
    mentor_ghl_id TEXT,               -- nullable; derived from the mentorship map at entry time

    -- The state-required fields
    session_date DATE NOT NULL,
    -- Whole-session duration (setup + procedure + teardown), self-reported.
    -- Always a positive multiple of 15 minutes — entered via a quarter-hour stepper, never free-typed.
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes % 15 = 0),

    -- Description + placement combine into the single "placement/description" column on export,
    -- but are stored separately for cleaner entry.
    description TEXT NOT NULL,         -- subject/style of the tattoo
    placement TEXT NOT NULL,          -- free text, e.g. "left forearm"

    -- Client attribution (courtesy / audit only — not required for the state column)
    client_name TEXT,                 -- auto-filled from the client picker, editable, may be blank
    contact_id TEXT,                  -- GHL contact id from the picker, when tied to a real booking

    -- Mentor sign-off — reserved for future in-app sign-off; the .xlsx export ships a blank
    -- initials column for Lionel to sign by hand after printing.
    mentor_signed_off_at TIMESTAMPTZ,
    mentor_initials TEXT,

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_apprentice_hours_apprentice ON apprentice_hours(apprentice_ghl_id);
CREATE INDEX IF NOT EXISTS idx_apprentice_hours_session_date ON apprentice_hours(apprentice_ghl_id, session_date DESC);

-- Keep updated_at fresh on edits
CREATE OR REPLACE FUNCTION set_apprentice_hours_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apprentice_hours_updated_at ON apprentice_hours;
CREATE TRIGGER trg_apprentice_hours_updated_at
    BEFORE UPDATE ON apprentice_hours
    FOR EACH ROW
    EXECUTE FUNCTION set_apprentice_hours_updated_at();

-- ============================================
-- Row Level Security — apprentice + owner/admin ONLY (peer artists excluded)
-- ============================================
ALTER TABLE apprentice_hours ENABLE ROW LEVEL SECURITY;

-- Helper predicate reused across policies:
--   the caller is the apprentice who owns the row, OR an owner/admin.
-- (Andrew, a peer artist, matches neither and therefore sees nothing.)

CREATE POLICY "Apprentice or admin can view hours"
ON apprentice_hours FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM profiles
        WHERE profiles.id = auth.uid()
          AND (
              profiles.ghl_user_id = apprentice_hours.apprentice_ghl_id
              OR profiles.role IN ('owner', 'admin')
          )
    )
);

CREATE POLICY "Apprentice can insert own hours; admin any"
ON apprentice_hours FOR INSERT
WITH CHECK (
    EXISTS (
        SELECT 1 FROM profiles
        WHERE profiles.id = auth.uid()
          AND (
              profiles.ghl_user_id = apprentice_hours.apprentice_ghl_id
              OR profiles.role IN ('owner', 'admin')
          )
    )
);

CREATE POLICY "Apprentice or admin can update hours"
ON apprentice_hours FOR UPDATE
USING (
    EXISTS (
        SELECT 1 FROM profiles
        WHERE profiles.id = auth.uid()
          AND (
              profiles.ghl_user_id = apprentice_hours.apprentice_ghl_id
              OR profiles.role IN ('owner', 'admin')
          )
    )
);

CREATE POLICY "Apprentice or admin can delete hours"
ON apprentice_hours FOR DELETE
USING (
    EXISTS (
        SELECT 1 FROM profiles
        WHERE profiles.id = auth.uid()
          AND (
              profiles.ghl_user_id = apprentice_hours.apprentice_ghl_id
              OR profiles.role IN ('owner', 'admin')
          )
    )
);

-- Documentation
COMMENT ON TABLE apprentice_hours IS 'Minnesota body-art apprentice licensure hour log. Self-logged by the apprentice; visible to apprentice + owner/admin only (not peer artists). Exported to .xlsx for state submission.';
COMMENT ON COLUMN apprentice_hours.duration_minutes IS 'Whole-session minutes (setup+procedure+teardown), positive multiple of 15.';
COMMENT ON COLUMN apprentice_hours.description IS 'Subject/style of the tattoo — half of the state "placement/description" column.';
COMMENT ON COLUMN apprentice_hours.placement IS 'Body placement free text (e.g. "left forearm") — other half of the state column.';
COMMENT ON COLUMN apprentice_hours.mentor_initials IS 'Reserved for future in-app mentor sign-off; the .xlsx export ships this column blank for hand-signing.';
