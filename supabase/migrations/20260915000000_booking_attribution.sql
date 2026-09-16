-- Ad-attribution rows written at booking time by the website widget.
-- One row per successful booking that carried any attribution: the
-- first-touch source/campaign (mirrors the GHL contact fields, but
-- queryable — the ROAS readout joins on lead_campaign here instead of
-- searching GHL) plus Meta's _fbp/_fbc click ids for CAPI Purchase
-- matching. Server-only (service role); RLS on with no policies so the
-- published anon key reads nothing.
--
-- Applied via Supabase MCP 2026-09-15 (CLI db push blocked by drift).
create table if not exists booking_attribution (
  id uuid primary key default gen_random_uuid(),
  contact_id text not null,
  appointment_id text,
  lead_source text,
  lead_campaign text,
  fbp text,
  fbc text,
  landing_page text,
  created_at timestamptz not null default now()
);

create index if not exists booking_attribution_contact_idx
  on booking_attribution (contact_id, created_at desc);
create index if not exists booking_attribution_campaign_idx
  on booking_attribution (lead_campaign);

alter table booking_attribution enable row level security;
