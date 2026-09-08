-- Give a transaction a place to record that a human settled it.
--
-- Until now there was nowhere to write "I looked at this and it is fine".
-- Review state lived in the Square sync response and a device-local cache, so
-- every queue was recomputed from scratch and nothing could ever be finished.
--
-- The Venmo queue shows the cost most plainly. It is defined as
-- `contact_id = 'venmo_unmatched' OR appointment_id IS NULL`, a derived
-- condition with no off switch: a Venmo payment that simply never got linked to
-- an appointment nags forever. On 2026-09-07 that queue held 32 payments going
-- back to 2026-02-12, 24 of which had a correct contact and correct amount and
-- were missing only an appointment link that is no longer recoverable months
-- after the fact.
--
-- reviewed_at is the off switch. It says nothing about whether the row is
-- "right" — only that its attribution has been settled and it should stop
-- being asked about.

alter table public.transactions
  add column if not exists reviewed_at  timestamptz,
  add column if not exists reviewed_by  text,
  add column if not exists review_note  text;

comment on column public.transactions.reviewed_at is
  'When this row''s attribution was settled. Non-null = suppress it from every review queue. Clearing it (set null) puts the row back in the queue — reviewing is always reversible.';

comment on column public.transactions.reviewed_by is
  'Who settled it: a GHL user id for a person, or "auto:<rule>" when a rule did (e.g. auto:legacy_venmo_link_unrecoverable). Makes it possible to audit, and to undo, one rule''s decisions without touching anyone else''s.';

comment on column public.transactions.review_note is
  'Optional free text: what was decided and why.';

-- The review queues all filter on this, so index the "still needs review" side.
create index if not exists transactions_unreviewed_idx
  on public.transactions (artist_ghl_id, session_date)
  where reviewed_at is null and deleted_at is null and superseded_by is null;
