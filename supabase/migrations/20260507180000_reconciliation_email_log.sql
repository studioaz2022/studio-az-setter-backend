-- Phase 5: Audit log for the Venmo email reconciliation parser.
-- Captures every email the parser inspects so deferred / ignored / settled
-- decisions are queryable for debugging and "please confirm" follow-up.
-- See TATTOO_FINANCE_PLAN.md Phase 5.

create table if not exists reconciliation_email_log (
  id uuid primary key default gen_random_uuid(),
  raw_payload jsonb,
  parsed_sender text,
  parsed_amount numeric(10, 2),
  parsed_note text,
  parsed_code text,
  parsed_direction text,
  artist_ghl_id text,
  reconciliation_id uuid references reconciliations(id) on delete set null,
  decision text not null check (decision in (
    'settled',
    'deferred_no_code',
    'deferred_amount_mismatch',
    'deferred_direction_mismatch',
    'deferred_unknown_code',
    'deferred_already_settled',
    'ignored_not_recon',
    'error'
  )),
  decision_note text,
  created_at timestamptz not null default now()
);

create index if not exists reconciliation_email_log_artist_idx
  on reconciliation_email_log (artist_ghl_id, created_at desc);

create index if not exists reconciliation_email_log_decision_idx
  on reconciliation_email_log (decision, created_at desc);

create index if not exists reconciliation_email_log_recon_idx
  on reconciliation_email_log (reconciliation_id) where reconciliation_id is not null;
