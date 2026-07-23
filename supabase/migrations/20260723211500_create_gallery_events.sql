-- Gallery marketing analytics — per-image event stream.
-- future-marketing-platform-roadmap.md Phase 4, grafted onto the live
-- barber gallery. photo_id references gallery_photos.id in the separate
-- barber-gallery Supabase project (cross-project → no FK; the ingest API
-- validates shape). Aggregations count DISTINCT session_id per photo so
-- client-side dedupe failures can never inflate stats.
--
-- NOTE: applied to prod 2026-07-23 via Supabase MCP (apply_migration
-- "create_gallery_events"). Statements are idempotent so a future
-- `supabase db push` no-ops cleanly.

create table if not exists gallery_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('impression','flip','book_click','bio_click','conversion')),
  photo_id uuid not null,
  barber_slug text not null,
  session_id uuid not null,
  page text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  contact_id text,
  created_at timestamptz not null default now()
);

create index if not exists gallery_events_photo_idx on gallery_events (photo_id, event_type);
create index if not exists gallery_events_barber_time_idx on gallery_events (barber_slug, created_at desc);
create index if not exists gallery_events_session_idx on gallery_events (session_id);

-- Service-role only: RLS on with NO policies. All reads/writes go through
-- the setter backend (validation + caps); nothing is exposed to anon keys.
alter table gallery_events enable row level security;
