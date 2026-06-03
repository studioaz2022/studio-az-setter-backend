-- Tag financial transactions with their Square environment so SANDBOX test-card deposits
-- (created only for allowlisted test phones) can be excluded from real revenue / commission /
-- settlement reporting and cleaned up. Default 'production' so every existing + real row is
-- unaffected. Reports should filter `environment = 'production'` (or `<> 'sandbox'`).

alter table if exists transactions
  add column if not exists environment text not null default 'production';

create index if not exists idx_transactions_environment on transactions (environment);
