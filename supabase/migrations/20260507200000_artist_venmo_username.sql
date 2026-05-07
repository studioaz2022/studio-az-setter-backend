-- Phase 6a: Per-artist Venmo handle for Pay Out deep links.
-- The Shop Settlements iOS board uses this to construct
-- venmo://paycharge?txn=pay&recipients=<username>&... links.
-- Null is fine and falls back to clipboard-copy in the iOS UI.
-- See TATTOO_FINANCE_PLAN.md Phase 6a.

alter table artist_commission_rates
  add column if not exists venmo_username text;
