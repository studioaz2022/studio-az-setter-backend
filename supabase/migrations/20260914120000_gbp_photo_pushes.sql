-- GBP photo freshness pipeline ledger (GBP_PHOTO_PIPELINE_PLAN.md).
-- Applied to remote 2026-09-14 via Supabase MCP (name: gbp_photo_pushes);
-- this file is the repo record.
-- Slot-claim pattern: a row is claimed BEFORE the push to Google, so a crash
-- can never double-post; 'claimed' rows that never became 'pushed' are
-- surfaced by /api/seo/gbp-photos/status rather than silently retried.
create table if not exists gbp_photo_pushes (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('tattoo','barber')),
  source_photo_id text not null,
  gbp_location text not null,
  source_url text not null,
  media_name text,
  status text not null default 'claimed' check (status in ('claimed','pushed','failed')),
  error text,
  created_at timestamptz not null default now(),
  unique (source, source_photo_id)
);

-- Server-only table: RLS on with no policies = anon/publishable keys see nothing;
-- the backend's service-role key bypasses RLS.
alter table gbp_photo_pushes enable row level security;
