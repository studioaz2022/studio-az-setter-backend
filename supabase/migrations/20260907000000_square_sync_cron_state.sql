-- Square sync cron: persisted state so the scheduled sweep can run unattended.
--
-- Two problems this supports fixing:
--
--  1. Nothing ever called refreshAllExpiringTokens(). Its own docblock said
--     "call this from a daily cron job" and no cron existed, so access tokens
--     ran to their 30-day expiry and the connection appeared dead — barbers
--     were told to re-do OAuth when a refresh would have worked the whole
--     time. Gilberto's token (F6m7GBKeyIRcehYkubfe) expired 2026-09-04 and
--     refreshed cleanly on 2026-09-07 with the credential already on file.
--
--  2. Alerting a barber that they need to reconnect must not fire on every
--     tick. Suppression has to survive a process restart, so it lives here
--     rather than in module memory.

alter table public.barber_square_tokens
  add column if not exists last_reauth_alert_at timestamptz,
  add column if not exists last_cron_sync_at    timestamptz,
  add column if not exists last_cron_error      text;

comment on column public.barber_square_tokens.last_reauth_alert_at is
  'Set immediately BEFORE a reconnect push is sent (claim-then-send), so a failure mid-send suppresses rather than repeats. Cleared on a successful token refresh.';

comment on column public.barber_square_tokens.last_cron_sync_at is
  'Last time the scheduled sweep synced this barber. Distinct from last_synced_at, which any app-triggered sync also updates — comparing the two shows whether the cron is actually carrying the load.';

comment on column public.barber_square_tokens.last_cron_error is
  'Last error from the scheduled sweep, or null when the most recent run succeeded. Read by GET /api/barbers/square/sync-health.';
