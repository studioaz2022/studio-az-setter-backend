-- Add utilization tracking columns to barber_analytics_snapshots.
-- These are populated by the nightly snapshot cron (live Free Slots API)
-- and by the backfill-utilization endpoint (historical Calendar Events + openHours).
--
-- capacity_minutes:   total bookable minutes (free slots + appointment minutes)
-- utilized_minutes:   actual booked appointment minutes
-- free_slot_minutes:  remaining bookable minutes
-- utilization:        utilized / capacity as a 0.0000–1.0000 decimal

ALTER TABLE barber_analytics_snapshots
  ADD COLUMN IF NOT EXISTS capacity_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS utilized_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS free_slot_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS utilization NUMERIC(5,4);
