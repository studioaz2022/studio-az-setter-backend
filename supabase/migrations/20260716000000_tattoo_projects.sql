-- tattoo_projects — canonical per-project tattoo history ledger
-- (TATTOO_PROJECT_HISTORY_PLAN.md §8/§12). One row per tattoo project:
-- ideas that were abandoned/superseded AND tattoos actually executed in shop.
-- Server-only table: written by the backend with the service-role key, read by
-- the backend GET endpoint for iOS. No RLS by convention (supabase_rls_convention).

create table if not exists tattoo_projects (
  id                    uuid primary key default gen_random_uuid(),
  contact_id            text not null,
  location_id           text not null default 'mUemx2jG4wly4kJWBkI4',
  opportunity_id        text,
  project_number        int  not null default 1,
  status                text not null default 'active',   -- active|abandoned|superseded|completed
  executed              boolean not null default false,    -- true only when corroborated (Square tx + completed appt)
  executed_at           timestamptz,
  -- idea snapshot (mirrors IDEA_FIELD_KEYS in src/config/tattooIdeaFields.js)
  tattoo_title          text,
  tattoo_summary        text,
  tattoo_placement      text,
  tattoo_style          text,
  tattoo_size           text,
  tattoo_color_preference text,
  budget_range          text,
  how_soon_deciding     text,
  first_tattoo          text,
  tattoo_concerns       text,
  tattoo_photo_description text,
  design_readiness      text,
  consultation_preference text,
  reference_photo_urls  jsonb,
  assigned_technician   text,
  inquired_technician   text,
  -- money snapshot
  final_price           numeric,
  quote_to_client       text,
  deposit_paid          boolean,
  deposit_amount_usd    numeric,
  -- narrative
  conversation_summary  text,
  source                text,         -- funnel|ai-setter|fill-flow|bio-link|completion|backfill
  created_at            timestamptz not null default now(),
  closed_at             timestamptz
);

create index if not exists tattoo_projects_contact_idx
  on tattoo_projects (contact_id, project_number);

create index if not exists tattoo_projects_status_idx
  on tattoo_projects (contact_id, status);
