-- Front Desk Dashboard — sync heartbeat (Phase 1.7).
--
-- WHY: the "last synced / stale" banner needs to answer "is the GHL→cache
-- pipeline ALIVE?" — not "were today's appointments recently changed?".
-- Appointment writes are event-driven and sporadic: a quiet afternoon
-- with zero bookings produces zero writes even though sync is perfectly
-- healthy. So newest-appointment-write age CANNOT distinguish
-- "pipeline down" from "nothing happened". (See FRONT_DESK_DASHBOARD_PLAN
-- Section 10 / Section 12.)
--
-- A heartbeat fixes this: a single row per location that is "touched"
-- whenever we have PROOF the pipeline is working —
--   - every successful /webhooks/ghl/appointments hit (event-driven), AND
--   - every periodic reconciler sweep (fixed ~10-15min cadence, Phase 4).
-- The sweep guarantees the heartbeat advances even on a zero-booking day,
-- so "heartbeat older than ~20min during the day" genuinely means the
-- pipeline is degraded, not just quiet.
--
-- One row per location_id (upsert on conflict). Tiny + hot, no history.

CREATE TABLE IF NOT EXISTS sync_heartbeat (
    location_id   TEXT PRIMARY KEY,
    last_beat_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    source        TEXT,        -- 'webhook' | 'reconciler' (what last proved liveness)
    detail        TEXT         -- optional context (e.g. event type, sweep stats)
);

-- Backend writes/reads with the service role (bypasses RLS). Lock out
-- direct client access; allow owner/admin read (mirrors the appointments
-- / frontdesk_audit_log RLS model). No write policies => only service role.
ALTER TABLE sync_heartbeat ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners and admins can read sync heartbeat"
ON sync_heartbeat
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM profiles
        WHERE profiles.id = auth.uid()
        AND profiles.role IN ('owner', 'admin')
    )
);

COMMENT ON TABLE sync_heartbeat IS
    'One row per GHL location. last_beat_at advances on every webhook hit AND every reconciler sweep — the honest "is the cache pipeline alive?" signal for the front-desk stale banner. See FRONT_DESK_DASHBOARD_PLAN Section 10.';
