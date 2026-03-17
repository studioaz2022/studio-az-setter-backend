-- Add availability-adjusted scoring columns to barber_analytics_snapshots.
-- These are computed by the break-aware capacity engine in analyticsQueries.js
-- and populated by the nightly snapshot cron + backfill-utilization endpoint.
--
-- raw_schedule_minutes:          total schedule minutes before any deductions
-- discretionary_blocked_minutes: non-recurring blocked time (PTO, time off)
-- availability_index:            (rawSchedule - discretionaryBlocked) / rawSchedule × 100
-- shop_impact:                   utilization × availabilityIndex / 100
-- blocked_percent:               discretionaryBlocked / rawSchedule × 100
-- at_risk:                       true when blocked_percent >= 25%

ALTER TABLE barber_analytics_snapshots
  ADD COLUMN IF NOT EXISTS raw_schedule_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS discretionary_blocked_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS availability_index NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS shop_impact NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS blocked_percent NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS at_risk BOOLEAN DEFAULT FALSE;
