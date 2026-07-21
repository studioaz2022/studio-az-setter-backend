-- Migration: staff_google_calendars
-- Multi-calendar support for the Google Calendar two-way sync: staff events
-- live on SECONDARY calendars (created or subscribed — e.g. a personal
-- calendar or a team schedule feed), not just 'primary'. One row per synced
-- calendar per staff member; watch-channel state + sync cursor move here
-- (the single-calendar columns on staff_google_tokens become legacy).

CREATE TABLE IF NOT EXISTS staff_google_calendars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_ghl_user_id TEXT NOT NULL,
  google_calendar_id TEXT NOT NULL,   -- calendarList entry id ('primary' resolved to real id)
  summary TEXT,                        -- calendar display name (for iOS/debug)
  access_role TEXT,                    -- owner | writer | reader | freeBusyReader
  is_primary BOOLEAN DEFAULT false,
  selected BOOLEAN DEFAULT true,       -- mirrors the checkbox in Google Calendar UI

  -- Per-calendar incremental sync + push channel state
  sync_token TEXT,
  watch_channel_id TEXT,
  watch_resource_id TEXT,
  watch_expiration TIMESTAMPTZ,
  watch_channel_token TEXT,

  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (staff_ghl_user_id, google_calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_google_calendars_staff
  ON staff_google_calendars (staff_ghl_user_id);
CREATE INDEX IF NOT EXISTS idx_staff_google_calendars_channel
  ON staff_google_calendars (watch_channel_id);
CREATE INDEX IF NOT EXISTS idx_staff_google_calendars_expiration
  ON staff_google_calendars (watch_expiration);

CREATE OR REPLACE FUNCTION update_staff_google_calendars_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_google_calendars_updated_at
  BEFORE UPDATE ON staff_google_calendars
  FOR EACH ROW EXECUTE FUNCTION update_staff_google_calendars_updated_at();

ALTER TABLE staff_google_calendars ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON staff_google_calendars
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Events from different calendars can (rarely) share an event id — e.g. an
-- invite that appears on two synced calendars. Uniqueness must include the
-- calendar.
ALTER TABLE google_calendar_events
  DROP CONSTRAINT IF EXISTS google_calendar_events_staff_ghl_user_id_google_event_id_key;
ALTER TABLE google_calendar_events
  ADD CONSTRAINT google_calendar_events_staff_cal_event_key
  UNIQUE (staff_ghl_user_id, google_calendar_id, google_event_id);
