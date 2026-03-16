-- Add created_at column to appointments table for rebook attempt proxy tracking.
-- The rebook attempt rate needs to know WHEN a future appointment was created
-- (same day as the visit = "booked next visit before leaving").

-- Add the column (nullable, no default — we'll backfill existing rows)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- Backfill: use ghl_created_at (GHL's dateAdded) where available, fall back to start_time
UPDATE appointments
SET created_at = COALESCE(ghl_created_at, start_time)
WHERE created_at IS NULL;

-- Set default for future rows so Supabase auto-populates if webhook doesn't provide it
ALTER TABLE appointments ALTER COLUMN created_at SET DEFAULT now();
