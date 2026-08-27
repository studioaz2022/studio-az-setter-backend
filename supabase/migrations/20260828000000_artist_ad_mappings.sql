-- artist_ad_mappings — source of truth for resolving an artist to their Meta ad set.
-- Ads Transparency feature (ADS_TRANSPARENCY_PLAN.md Phase 0).
--
-- One brand campaign → one ad set per artist. The backend resolves
-- ghl_user_id → meta_ad_set_id here, then pulls ad-set-level insights.
--
-- purpose:
--   client_acquisition — artist-billed ads targeting clients (ghl_user_id required)
--   recruitment       — shop-level ads attracting barbers/tattoo artists as talent
--                       (ghl_user_id NULL, never billed to an artist, owner-only view)
--
-- meta_pixel_id: the pixel this ad set optimizes on. Tattoo mode and barber mode
-- run different pixels so each learns its own clientele; recruitment funnels get
-- their own pixel (or none, for in-Meta lead forms) so career-seeker signal never
-- pollutes client targeting.
--
-- Server-only table — no RLS by repo convention (service-role access only).

create table public.artist_ad_mappings (
  id uuid primary key default gen_random_uuid(),
  ghl_user_id text,
  artist_name text not null,
  brand text not null check (brand in ('tattoo_shop', 'barber_shop')),
  purpose text not null default 'client_acquisition'
    check (purpose in ('client_acquisition', 'recruitment')),
  meta_campaign_id text not null,
  meta_ad_set_id text not null,
  meta_pixel_id text,
  ad_account_id text not null default 'act_270470901',
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- client-acquisition rows must belong to an artist; recruitment rows are shop-level
  constraint artist_ad_mappings_artist_required
    check (purpose = 'recruitment' or ghl_user_id is not null)
);

-- an ad set can only be actively mapped once
create unique index artist_ad_mappings_adset_active_uidx
  on public.artist_ad_mappings (meta_ad_set_id)
  where active;

-- fast lookup path for the insights endpoint
create index artist_ad_mappings_ghl_user_idx
  on public.artist_ad_mappings (ghl_user_id)
  where active;
