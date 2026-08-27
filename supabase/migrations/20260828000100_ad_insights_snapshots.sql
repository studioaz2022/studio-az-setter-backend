-- ad_insights_snapshots — cache of Meta ad-set insights per artist + date range.
-- Ads Transparency Phase 2. Serve cached payload when fresh (60-min TTL) to
-- respect Meta rate limits; nightly cron may later pre-warm. Server-only, no RLS.

create table public.ad_insights_snapshots (
  id uuid primary key default gen_random_uuid(),
  mapping_id uuid not null references public.artist_ad_mappings(id) on delete cascade,
  ghl_user_id text,
  range_key text not null,          -- e.g. 'last_30d' or '2026-06-01_2026-07-17'
  payload jsonb not null,           -- normalized metrics object served to iOS
  fetched_at timestamptz not null default now()
);

create index ad_insights_snapshots_lookup_idx
  on public.ad_insights_snapshots (mapping_id, range_key, fetched_at desc);
