-- Phase 7g: Edit / undo for manually-logged payments.
-- The artist-edit endpoint inserts a new row and stamps superseded_by on
-- the original (audit-trail-preserving — never mutates in place). The
-- artist-undo endpoint soft-deletes via deleted_at. Read endpoints filter
-- both columns to keep the visible payment list clean while preserving
-- the full history for audit.
--
-- Restrictions enforced server-side: only payment_recipient='artist_direct'
-- + not-yet-settled rows are editable/undoable (409 otherwise).
--
-- See TATTOO_FINANCE_PLAN.md Phase 7g.

alter table transactions
  add column if not exists superseded_by uuid references transactions(id) on delete set null,
  add column if not exists deleted_at timestamptz;

create index if not exists transactions_active_idx
  on transactions (contact_id, session_date desc)
  where superseded_by is null and deleted_at is null;

create index if not exists transactions_supersede_chain_idx
  on transactions (superseded_by) where superseded_by is not null;
