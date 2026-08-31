-- ad_spend_ledger — per-artist running balance for fronted Meta ad spend.
-- Ads Transparency Phase 4 (ADS_TRANSPARENCY_PLAN.md).
--
-- debit  = spend accrued for a period (source 'meta_accrual', period required)
-- credit = repayment (source 'venmo'/'manual'; external_ref = Venmo tx for dedup)
-- balance owed = sum(debits) - sum(credits)
--
-- Accrual idempotency: one meta_accrual debit per artist per period, enforced
-- by a partial unique index — re-running an accrual can never double-bill.
-- Server-only table — no RLS by repo convention.

create table public.ad_spend_ledger (
  id uuid primary key default gen_random_uuid(),
  ghl_user_id text not null,
  artist_name text not null,
  entry_type text not null check (entry_type in ('debit', 'credit')),
  amount numeric(10,2) not null check (amount > 0),
  period_start date,
  period_end date,
  source text not null,
  external_ref text,
  note text,
  created_at timestamptz not null default now(),

  -- an accrual debit must say what period it covers
  constraint ad_spend_ledger_debit_period
    check (entry_type <> 'debit' or (period_start is not null and period_end is not null))
);

create unique index ad_spend_ledger_accrual_uidx
  on public.ad_spend_ledger (ghl_user_id, period_start, period_end)
  where entry_type = 'debit' and source = 'meta_accrual';

-- dedup Venmo credits by transaction reference
create unique index ad_spend_ledger_external_ref_uidx
  on public.ad_spend_ledger (ghl_user_id, external_ref)
  where external_ref is not null;

create index ad_spend_ledger_artist_idx
  on public.ad_spend_ledger (ghl_user_id, created_at desc);
