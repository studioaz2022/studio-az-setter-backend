-- Barber job applications from the careers page (minneapolisbarbershop.com/careers).
-- Written by POST /api/careers/apply; read + status-updated by the iOS app's
-- Lionel-only Applicants screen (x-owner-key gated backend routes).
--
-- Server-only table (backend service role) — no RLS, per workspace convention.

create table if not exists public.barber_applications (
  id uuid primary key default gen_random_uuid(),

  -- The five wizard answers
  name text not null,
  phone text not null,
  email text not null,
  portfolio text not null,          -- Instagram / public portfolio link (required by the form)
  experience text not null,         -- years cutting + current clientele
  fit text not null,                -- Q4: what they want / what they contribute (entitlement read)
  feedback text not null,           -- Q5: difficult-feedback story (coachability read)

  source text not null default 'careers_page',
  ghl_contact_id text,              -- set after the barbershop-location upsert succeeds

  status text not null default 'new'
    check (status in ('new', 'contacted', 'interview', 'accepted', 'rejected', 'archived')),
  reviewed_at timestamptz,
  review_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists barber_applications_status_idx
  on public.barber_applications (status, created_at desc);

-- Same person applying twice within a short window is a resubmit, not a new
-- application — the route treats a recent duplicate (same email) as idempotent.
create index if not exists barber_applications_email_idx
  on public.barber_applications (email, created_at desc);
