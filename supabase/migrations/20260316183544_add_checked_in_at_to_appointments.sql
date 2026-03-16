-- Add checked_in_at timestamp for kiosk check-in tracking
-- Used by iOS calendar to render "Arrived" state on appointment cards

ALTER TABLE appointments ADD COLUMN checked_in_at TIMESTAMPTZ DEFAULT NULL;

-- Partial index: only index rows that have been checked in (sparse)
CREATE INDEX idx_appointments_checked_in_at
  ON appointments (checked_in_at)
  WHERE checked_in_at IS NOT NULL;
