-- Front Desk Dashboard — audit log (Phase 0.3c).
--
-- The front-desk dashboard runs on a trusted device with NO login
-- (FRONT_DESK_DASHBOARD_PLAN.md Section 1). Accountability is provided by
-- self-identification: before every SENSITIVE action (book, reschedule,
-- cancel, no-show, block create/remove, message send) the operator taps
-- their face in the identity wizard (Section 8). That identity + the
-- action is recorded here.
--
-- This is a FORENSIC, APPEND-ONLY record:
--   - Written by the backend using the Supabase SERVICE ROLE (bypasses
--     RLS), after the GHL call — recording BOTH success and failure.
--   - Not user-facing in v1 (no browse UI).
--   - Identity is honor-system, not authentication (Section 6) — the row
--     says "whoever was acting as X", not cryptographic proof. Documented
--     so it isn't over-trusted later.
--   - check_in is logged here too but is attributed to the *session*
--     identity (it skips the wizard — high-freq/low-stakes, Section 8.3),
--     so its attribution is best-effort, not guaranteed-exact.
--
-- No UPDATE/DELETE policies on purpose: append-only.

CREATE TABLE IF NOT EXISTS frontdesk_audit_log (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Which shop the action was performed against.
    location                  TEXT NOT NULL,            -- 'barbershop' | 'tattoo' (or raw locationId)

    -- Self-identified operator (from the identity wizard / session identity).
    acting_staff_ghl_user_id  TEXT,                      -- nullable: unknown / not yet identified
    acting_staff_name         TEXT,                      -- denormalized for readability even if roster changes

    -- What happened.
    action                    TEXT NOT NULL,             -- book | reschedule | cancel | no_show |
                                                         -- block_create | block_remove | message_send | check_in
    target_type               TEXT,                      -- 'appointment' | 'contact' | 'block'
    target_id                 TEXT,                      -- GHL appointment/contact id when applicable

    summary                   TEXT,                      -- short human line (e.g. "Booked Mike 2:00 w/ Drew")
    payload                   JSONB,                      -- full request context for forensics

    result                    TEXT NOT NULL DEFAULT 'success',  -- 'success' | 'failed'
    error_text                TEXT                        -- populated when result = 'failed'
);

-- Query patterns: by time (recent activity), by operator, by action,
-- by the appointment/contact a row touched.
CREATE INDEX IF NOT EXISTS idx_frontdesk_audit_created_at
    ON frontdesk_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_frontdesk_audit_staff
    ON frontdesk_audit_log (acting_staff_ghl_user_id);
CREATE INDEX IF NOT EXISTS idx_frontdesk_audit_action
    ON frontdesk_audit_log (action);
CREATE INDEX IF NOT EXISTS idx_frontdesk_audit_target
    ON frontdesk_audit_log (target_id);

-- RLS: lock out direct client access entirely. The backend writes with
-- the service role (which bypasses RLS). There are no end-user writers
-- (no login on the dashboard). Mirrors the appointments-table model:
-- read for authenticated, no write policies for anyone (=> only the
-- service role can write).
ALTER TABLE frontdesk_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners and admins can read frontdesk audit log"
ON frontdesk_audit_log
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM profiles
        WHERE profiles.id = auth.uid()
        AND profiles.role IN ('owner', 'admin')
    )
);

COMMENT ON TABLE frontdesk_audit_log IS
    'Append-only forensic record of sensitive front-desk dashboard actions. Written by backend service role after the GHL call (success + failure). Identity is self-identified honor-system, not auth. See FRONT_DESK_DASHBOARD_PLAN.md Section 8.';
COMMENT ON COLUMN frontdesk_audit_log.acting_staff_ghl_user_id IS
    'Self-identified operator from the identity wizard; for check_in this is the session identity (best-effort, not guaranteed-exact).';
COMMENT ON COLUMN frontdesk_audit_log.result IS
    'success | failed — failed writes (GHL call errored) are still logged for forensics.';
