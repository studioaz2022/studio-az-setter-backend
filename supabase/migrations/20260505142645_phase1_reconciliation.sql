-- Phase 1: Reconciliation engine tables.
-- See TATTOO_FINANCE_PLAN.md Phase 1.

create table if not exists project_completions (
  id uuid primary key default gen_random_uuid(),
  contact_id text not null,
  artist_ghl_id text not null,
  completed_at timestamptz not null default now(),
  completed_by text,
  quote_at_completion numeric(10, 2) not null,
  collected_at_completion numeric(10, 2) not null,
  net_to_artist numeric(10, 2) not null,
  shop_percentage_at_completion numeric(5, 2) not null,
  artist_percentage_at_completion numeric(5, 2) not null,
  reconciliation_id uuid,
  created_at timestamptz not null default now(),
  unique (contact_id, artist_ghl_id)
);

create index if not exists project_completions_artist_idx
  on project_completions (artist_ghl_id, completed_at);

create index if not exists project_completions_unsettled_idx
  on project_completions (artist_ghl_id) where reconciliation_id is null;

create table if not exists reconciliations (
  id uuid primary key default gen_random_uuid(),
  artist_ghl_id text not null,
  week_start date not null,
  week_end date not null,
  net_amount numeric(10, 2) not null,
  direction text not null check (direction in ('shop_owes_artist', 'artist_owes_shop')),
  status text not null default 'pending' check (status in ('pending', 'settled')),
  venmo_code text not null,
  venmo_note text not null,
  project_count integer not null,
  settled_at timestamptz,
  settled_via text check (settled_via in ('venmo_auto', 'venmo_manual', 'cash', 'other')),
  settlement_payment_id text,
  created_at timestamptz not null default now(),
  unique (artist_ghl_id, week_start),
  unique (venmo_code)
);

create index if not exists reconciliations_status_idx
  on reconciliations (artist_ghl_id, status, week_start desc);

alter table project_completions
  add constraint project_completions_reconciliation_fkey
  foreign key (reconciliation_id) references reconciliations(id) on delete set null;
