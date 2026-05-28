-- Phase 8: Net-Settlement Consolidation
-- See TATTOO_FINANCE_PLAN.md Phase 8.
--
-- Adds support for "rollup" reconciliations that consolidate multiple
-- still-pending child recons into a single net Venmo action. When the
-- rollup settles, the children cascade to settled with settled_via
-- 'rollup' and a shared settlement_payment_id pointing to the rollup.

-- 1. Columns on `reconciliations` for rollup support.
alter table reconciliations
  add column if not exists consolidates uuid[],
  add column if not exists parent_reconciliation_id uuid
    references reconciliations(id) on delete set null;

comment on column reconciliations.consolidates is
  'Phase 8 — array of child reconciliation_ids this rollup row consolidates. Set on the parent rollup only; NULL on regular weekly recons.';

comment on column reconciliations.parent_reconciliation_id is
  'Phase 8 — set on a CHILD recon when it was settled-by-cascade from a rollup. Points back to the rollup row that settled it. NULL on regular recons.';

-- 2. Expand settled_via enum to include rollup-cascade settlement.
alter table reconciliations
  drop constraint if exists reconciliations_settled_via_check;

alter table reconciliations
  add constraint reconciliations_settled_via_check
    check (settled_via in ('venmo_auto', 'venmo_manual', 'cash', 'other', 'rollup'));

-- 3. Replace the (artist_ghl_id, week_start) unique constraint with a
--    partial unique index that excludes rollup rows. Rollups don't follow
--    the "one per week" invariant because they consolidate across weeks.
alter table reconciliations
  drop constraint if exists reconciliations_artist_ghl_id_week_start_key;

create unique index if not exists reconciliations_artist_week_unique_idx
  on reconciliations (artist_ghl_id, week_start)
  where consolidates is null;

-- 4. Index for finding pending non-rollup recons per artist (used by
--    the consolidate endpoint to gather children).
create index if not exists reconciliations_pending_children_idx
  on reconciliations (artist_ghl_id, status)
  where consolidates is null and status = 'pending';

-- 5. Index for cascade-settle: find children by parent_reconciliation_id.
create index if not exists reconciliations_parent_idx
  on reconciliations (parent_reconciliation_id)
  where parent_reconciliation_id is not null;
