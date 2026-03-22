-- barber_analytics_settings: stores per-barber analytics tier preference
-- Tier controls dashboard presentation (hero metrics, tone/language) but not underlying data.

CREATE TABLE IF NOT EXISTS barber_analytics_settings (
  barber_ghl_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  analytics_tier TEXT DEFAULT 'growth' CHECK (analytics_tier IN ('growth', 'stable')),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for location-based lookups
CREATE INDEX IF NOT EXISTS idx_barber_analytics_settings_location
  ON barber_analytics_settings (location_id);
