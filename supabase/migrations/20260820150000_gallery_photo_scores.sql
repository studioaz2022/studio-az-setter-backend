-- Gallery ranking scores (GALLERY_RANKING_PLAN.md Phase 2).
-- One row per published gallery photo, recomputed every 6h by the backend's
-- scoring loop from gallery_events. breakdown carries every input to the
-- score — the transparency receipt the uploader /stats (and later the iOS
-- Analytics tab) shows barbers. Server-only table: no RLS by convention
-- (service-role writes, public reads go through GET /api/gallery/scores).
create table if not exists gallery_photo_scores (
  photo_id    uuid primary key,
  score       numeric not null,
  auditioning boolean not null default true,
  breakdown   jsonb not null,
  scored_at   timestamptz not null default now()
);
