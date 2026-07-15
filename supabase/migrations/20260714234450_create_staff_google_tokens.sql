-- Migration: create_staff_google_tokens
-- Stores per-staff (barber + tattoo artist) Google Calendar OAuth tokens so each
-- staff member's personal calendar can be two-way synced independently.
-- Mirrors barber_square_tokens. Tokens are NEVER exposed to clients — service role only.

CREATE TABLE IF NOT EXISTS staff_google_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- GHL user ID of the staff member (matches profiles.ghl_user_id)
  staff_ghl_user_id TEXT NOT NULL UNIQUE,

  -- Connected Google account (for display in the app)
  google_email TEXT,

  -- OAuth tokens
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_type TEXT DEFAULT 'Bearer',
  expires_at TIMESTAMPTZ,          -- access token expiry; refreshed via refresh_token
  scope TEXT,

  -- Which calendar we sync (default the account's primary)
  calendar_id TEXT DEFAULT 'primary',

  -- Google incremental-sync cursor (from events.list nextSyncToken)
  sync_token TEXT,

  -- Push-notification (events.watch) channel state
  watch_channel_id TEXT,           -- our generated channel id (uuid)
  watch_resource_id TEXT,          -- Google's opaque resource id
  watch_expiration TIMESTAMPTZ,    -- channel expiry (~7 days); renewal cron re-registers
  watch_channel_token TEXT,        -- secret echoed by Google in X-Goog-Channel-Token; validates the webhook

  -- Sync health / telemetry
  sync_status TEXT DEFAULT 'connected',  -- connected | error | disconnected
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,

  -- Meta
  location_id TEXT NOT NULL,        -- our GHL location (tattoo vs barbershop)
  connected_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Fast lookup by staff member
CREATE INDEX IF NOT EXISTS idx_staff_google_tokens_staff_ghl_user_id
  ON staff_google_tokens (staff_ghl_user_id);
-- Location-scoped queries
CREATE INDEX IF NOT EXISTS idx_staff_google_tokens_location_id
  ON staff_google_tokens (location_id);
-- Webhook receiver resolves the row by the push channel id
CREATE INDEX IF NOT EXISTS idx_staff_google_tokens_watch_channel_id
  ON staff_google_tokens (watch_channel_id);
-- Renewal cron scans for channels nearing expiry
CREATE INDEX IF NOT EXISTS idx_staff_google_tokens_watch_expiration
  ON staff_google_tokens (watch_expiration);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_staff_google_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_google_tokens_updated_at
  BEFORE UPDATE ON staff_google_tokens
  FOR EACH ROW EXECUTE FUNCTION update_staff_google_tokens_updated_at();

-- RLS: tokens are sensitive — only the backend (service role) may touch this table.
-- Clients learn connection status through a server-side /google/status endpoint, never
-- by reading tokens directly.
ALTER TABLE staff_google_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON staff_google_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);
