-- A local, searchable copy of the GHL contacts the front desk looks up.
--
-- WHY. Client lookup has been served by calling GHL on every keystroke, and
-- GHL's contact search cannot do what a front desk needs:
--
--   * Its `query` parameter matches an ordered word PREFIX. "kert" finds
--     nobody though three clients are named Milkert, Wieckert and Hockert;
--     "milkert spencer" found nobody at all.
--   * Its `filters`+`contains` operator does match substrings, but is
--     rejected below 3 characters and — measured repeatedly against the live
--     location — intermittently HANGS for 18-20 seconds on payloads that
--     answer in 3. A type-ahead cannot wait on that, so the request is
--     time-boxed and degrades to the weaker prefix path exactly when the desk
--     is busiest.
--
-- No amount of ranking fixes a dependency that randomly stops answering. The
-- fix is to stop asking GHL on the keystroke path: keep a copy here, search
-- it, and fall back to GHL only when the copy has nothing — which is
-- precisely the case of a client created seconds ago.
--
-- This is small. Measured over 100 real contacts the stored fields average
-- 104 bytes each; ~9,300 contacts across both locations is under 4 MB
-- including the trigram index, against an `appointments` table already
-- holding ~15 MB.
--
-- THE RISK, NAMED. A second copy can drift, and this codebase has already
-- paid for that once: the appointments cache held GHL blocks that had been
-- deleted a month earlier, and one of them hid a real 1:30pm booking from the
-- desk. Contacts have the identical failure mode — a client deleted or merged
-- in GHL still appearing here. So deletes are handled on the webhook and a
-- reconcile sweep removes rows GHL no longer has. A stale row is worse than a
-- missing one, because the desk trusts what it sees.

create extension if not exists pg_trgm;

create table if not exists public.frontdesk_contacts (
  -- The GHL contact id. Same key the rest of the system uses, so a row here
  -- joins straight onto appointments.contact_id.
  id              text primary key,
  location_id     text not null,

  contact_name    text,
  first_name      text,
  last_name       text,
  email           text,
  phone           text,

  assigned_to     text,
  tags            text[],

  -- GHL's own last-modified stamp, so a reconcile can tell which copy is
  -- newer instead of blindly overwriting.
  ghl_updated_at  timestamptz,
  -- When WE last wrote this row. A reconcile uses it to find rows nothing has
  -- touched in a while, which is how a deleted contact is spotted.
  synced_at       timestamptz not null default now(),

  -- Everything searchable, normalised once and stored, so the query side
  -- never has to lower()/strip on the fly and the index stays usable.
  --
  -- Generated rather than written by hand: the search column and the data it
  -- describes cannot drift apart if the database derives one from the other.
  -- Digits are appended bare so a phone SUFFIX is reachable — "3536" has to
  -- find the client whose number ends in it, which is what a desk actually
  -- asks for, and which GHL's prefix search got wrong by returning the
  -- contact whose NAME was a phone number.
  search_text     text generated always as (
    lower(
      coalesce(contact_name, '') || ' ' ||
      coalesce(first_name, '')   || ' ' ||
      coalesce(last_name, '')    || ' ' ||
      coalesce(email, '')        || ' ' ||
      regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
    )
  ) stored
);

-- The search index. GIN + trigram is what makes an unanchored LIKE '%...%'
-- fast; a btree cannot help a match that does not start at the beginning of
-- the string, which is the whole point of this table.
create index if not exists frontdesk_contacts_search_trgm
  on public.frontdesk_contacts using gin (search_text gin_trgm_ops);

-- Every query is scoped to one location (barbershop vs tattoo are separate
-- GHL locations with separate people in them).
create index if not exists frontdesk_contacts_location
  on public.frontdesk_contacts (location_id);

-- Drives the reconcile sweep's "what hasn't been confirmed lately" scan.
create index if not exists frontdesk_contacts_synced_at
  on public.frontdesk_contacts (location_id, synced_at);

comment on table public.frontdesk_contacts is
  'Local searchable mirror of GHL contacts for front-desk + iOS client lookup. NOT the source of truth: GHL is. Kept fresh by contact webhooks, written through on contact creation, and reconciled on a timer. Rows GHL no longer has must be deleted — a stale contact is worse than a missing one.';

comment on column public.frontdesk_contacts.search_text is
  'Generated: lowercased name + email + bare phone digits. Backs the trigram index, so substring name matches and phone-suffix lookups both work. Never write this column directly.';
