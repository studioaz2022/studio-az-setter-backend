-- Grid-Walk Utilization — Option B real-capacity columns + classifier breakdown.
--
-- The earlier grid-walk migration (20260319195204_grid_walk_snapshot_columns.sql)
-- added slot-marker counts. This migration completes the schema for the actual
-- production grid-walk implementation:
--
-- 1. Real-capacity equivalents (DECIMAL, pre-rounding) — needed for accurate
--    pooled aggregation. Storing only rounded integer slots loses precision
--    when the rolling window aggregates across many days.
--
-- 2. HC duration (slot_duration_minutes) — Option B uses duration, not interval,
--    as the divisor. Stored alongside slot_interval_minutes for compatibility.
--
-- 3. Classifier breakdown (synced/informal counts) — distinguishes external
--    booking platform syncs (Albe's Google Calendar) from informal walk-ins.
--    Useful for diagnostics and for explaining "where did these appointments
--    come from?"
--
-- 4. Total cancellation/no-show counts (in addition to the existing
--    "unfilled" counts) — the unfilled metric is a subset; we want both.
--
-- 5. Mode (historical / live / future) — tracks how this snapshot was
--    computed, which lets us re-process if needed.
--
-- 6. Free slots — already-derived metric we want to store for debugging.
--
-- All columns are nullable / defaulted so existing rows stay valid.
--
-- See GRID_WALK_UTILIZATION_PLAN.md and gridWalk.js for what each field
-- represents.

ALTER TABLE barber_analytics_snapshots

  -- Real-capacity equivalents (decimals — exact pre-rounding values)
  ADD COLUMN IF NOT EXISTS occupied_equivalents  DECIMAL,   -- sum of (appt_minutes / HC_DURATION) for in-schedule appts
  ADD COLUMN IF NOT EXISTS overtime_equivalents  DECIMAL,   -- sum of (appt_minutes / HC_DURATION) for off-grid starts

  -- HC duration (the Option B divisor)
  ADD COLUMN IF NOT EXISTS slot_duration_minutes INTEGER,   -- HC calendar duration (e.g., 30, 45)

  -- Free / capacity counts not yet stored
  ADD COLUMN IF NOT EXISTS free_slots            INTEGER,   -- max(0, scheduled - occupied - blocked)

  -- Cancellation / no-show totals (counts; the existing unfilled_* are subsets)
  ADD COLUMN IF NOT EXISTS cancelled_count       INTEGER,   -- total cancelled appts on the day
  ADD COLUMN IF NOT EXISTS noshow_count          INTEGER,   -- total no-showed appts on the day

  -- Classifier breakdown (from blocked-slots classification rules 1-6)
  ADD COLUMN IF NOT EXISTS synced_appointment_count   INTEGER,  -- Rule 1+2: external booking platform syncs
  ADD COLUMN IF NOT EXISTS informal_appointment_count INTEGER,  -- Rule 4: name-only entries (walk-ins / phone bookings)

  -- Snapshot mode
  ADD COLUMN IF NOT EXISTS snapshot_mode TEXT;              -- 'historical' | 'live' | 'future'

-- Comment on the table to capture the migration intent
COMMENT ON COLUMN barber_analytics_snapshots.occupied_equivalents IS
  'Real-capacity Option B numerator: sum(appt_min / HC_DURATION) for in-schedule appointments. Used for accurate pooled rolling-window aggregation.';
COMMENT ON COLUMN barber_analytics_snapshots.overtime_equivalents IS
  'Real-capacity Option B overtime: sum(appt_min / HC_DURATION) for GHL appts STARTING past schedule end.';
COMMENT ON COLUMN barber_analytics_snapshots.slot_duration_minutes IS
  'Haircut calendar slotDuration in minutes. Option B utilization = (occupied_eq + overtime_eq) / floor((work_min - break_min) / slot_duration_minutes).';
COMMENT ON COLUMN barber_analytics_snapshots.snapshot_mode IS
  'How this snapshot was computed: historical (Supabase appointments), live (GHL Calendar Events for today), future (GHL Calendar Events for upcoming).';
