-- Grid-Walk Utilization Algorithm — new snapshot columns.
-- These store per-day slot counts from the grid-walk algorithm, which
-- replaces the subtraction-based capacity engine.
--
-- The grid-walk generates a slot grid per calendar, classifies each slot
-- (occupied/free/break-blocked/manually-blocked), and derives utilization
-- from slot counts rather than minute-based subtraction.
--
-- Existing columns (capacity_minutes, utilized_minutes, free_slot_minutes,
-- utilization, raw_schedule_minutes, etc.) are retained for backwards
-- compatibility during migration. Once grid-walk is stable, the old
-- minute-based columns can be deprecated.
--
-- See GRID_WALK_UTILIZATION_PLAN.md for full algorithm spec.

ALTER TABLE barber_analytics_snapshots

  -- Core slot counts (HC calendar denominator)
  ADD COLUMN IF NOT EXISTS scheduled_slots     INTEGER,   -- occupied + free (break/blocked excluded)
  ADD COLUMN IF NOT EXISTS occupied_slots       INTEGER,   -- slots with active appointments
  ADD COLUMN IF NOT EXISTS overtime_slots       INTEGER,   -- appointments starting outside schedule grid
  ADD COLUMN IF NOT EXISTS break_blocked_slots  INTEGER,   -- slots blocked by recurring breaks
  ADD COLUMN IF NOT EXISTS manually_blocked_slots INTEGER, -- slots blocked by discretionary blocks (PTO, etc.)

  -- Impact tracking
  ADD COLUMN IF NOT EXISTS unfilled_cancelled_slots INTEGER, -- cancelled appts where slot stayed empty
  ADD COLUMN IF NOT EXISTS unfilled_noshow_slots    INTEGER, -- no-show appts where slot stayed empty

  -- Service mix efficiency
  ADD COLUMN IF NOT EXISTS dead_space_minutes    INTEGER,   -- unbookable gap minutes (short services + scheduling gaps)
  ADD COLUMN IF NOT EXISTS hc_dead_space_minutes INTEGER,   -- gaps measured against HC duration (coach-only metric)

  -- Grid config (for converting slots to minutes)
  ADD COLUMN IF NOT EXISTS slot_interval_minutes INTEGER;   -- HC calendar interval (e.g., 30 or 45)
