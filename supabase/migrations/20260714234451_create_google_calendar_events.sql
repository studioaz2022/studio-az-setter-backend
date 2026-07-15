-- Migration: create_google_calendar_events
-- One row per synced event in EITHER direction:
--   inbound  = a personal Google event mirrored into GHL as a block slot
--   outbound = a shop appointment (GHL) mirrored onto the staff member's Google calendar
-- Holds the Google eventId <-> GHL object mapping plus the real (privacy-gated) title so
-- the app can (a) show titles to authorized viewers, (b) support edit-back, (c) reconcile.

CREATE TABLE IF NOT EXISTS google_calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner of the calendar this event belongs to (matches profiles.ghl_user_id)
  staff_ghl_user_id TEXT NOT NULL,

  -- Google identifiers
  google_event_id TEXT NOT NULL,
  google_calendar_id TEXT DEFAULT 'primary',
  ical_uid TEXT,
  etag TEXT,                        -- for optimistic-concurrency on edit-back

  -- Sync direction + the paired GHL object
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  ghl_block_slot_id TEXT,           -- set when direction = inbound
  ghl_appointment_id TEXT,          -- set when direction = outbound

  -- Privacy-gated content. Returned to owner/admin + the own artist only; never to a
  -- client-readable table (RLS below is service-role only). Minimize what we store.
  real_title TEXT,
  real_description TEXT,

  -- Timing / state (kept in sync both ways for reconcile + display)
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  is_all_day BOOLEAN DEFAULT false,
  transparency TEXT,                -- 'opaque' (busy) | 'transparent' (free)
  status TEXT,                      -- confirmed | tentative | cancelled

  -- Meta
  location_id TEXT NOT NULL,        -- our GHL location (tattoo vs barbershop)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- One mapping row per (staff, google event)
  UNIQUE (staff_ghl_user_id, google_event_id)
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_events_staff
  ON google_calendar_events (staff_ghl_user_id);
CREATE INDEX IF NOT EXISTS idx_google_calendar_events_google_event_id
  ON google_calendar_events (google_event_id);
-- iOS correlates a rendered GHL block slot back to its real title via this id
CREATE INDEX IF NOT EXISTS idx_google_calendar_events_block_slot
  ON google_calendar_events (ghl_block_slot_id);
-- Outbound updates/cancels resolve by the source appointment
CREATE INDEX IF NOT EXISTS idx_google_calendar_events_appointment
  ON google_calendar_events (ghl_appointment_id);
CREATE INDEX IF NOT EXISTS idx_google_calendar_events_location
  ON google_calendar_events (location_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_google_calendar_events_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER google_calendar_events_updated_at
  BEFORE UPDATE ON google_calendar_events
  FOR EACH ROW EXECUTE FUNCTION update_google_calendar_events_updated_at();

-- RLS: rows carry personal event titles/descriptions -> service role only for now.
-- Phase 3 (privacy-tier display) will decide the client read path: either a server-side
-- endpoint that role-gates titles, or a narrowly-scoped authenticated SELECT policy
-- (own artist rows + owner/admin). Kept locked down until then.
ALTER TABLE google_calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON google_calendar_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
