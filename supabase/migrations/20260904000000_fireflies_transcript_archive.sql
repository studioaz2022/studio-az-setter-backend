-- Fireflies transcripts: make this table the archive, not just a ledger.
--
-- Until now it stored only metadata (title, date, status) while the words
-- themselves lived in exactly one place: four GHL custom fields on the
-- contact. Those fields are per-contact, so a client's second consultation
-- overwrites their first — Josh Bernia's 2026-08-25 call was destroyed by
-- his 2026-08-26 one.
--
-- Holding the text here makes every meeting durable and independently
-- addressable, which is the precondition for deleting anything from
-- Fireflies to reclaim storage.

alter table public.fireflies_transcripts
  add column if not exists transcript_text    text,
  add column if not exists summary_text       text,
  add column if not exists fireflies_summary  jsonb,
  add column if not exists duration_minutes   numeric,
  add column if not exists ghl_note_id        text,
  add column if not exists archived_at        timestamptz;

comment on column public.fireflies_transcripts.transcript_text is
  'Full speaker-labeled, timestamped transcript. The canonical copy — GHL custom fields hold only the most recent consult per contact.';
comment on column public.fireflies_transcripts.summary_text is
  'Our own consultationSummarizer output, tuned for tattoo consults.';
comment on column public.fireflies_transcripts.fireflies_summary is
  'Fireflies own AI summary (overview/action_items/keywords/outline). Free-plan accessible, unlike audio_url/video_url — archived because it is lost on delete.';
comment on column public.fireflies_transcripts.duration_minutes is
  'Meeting length. Fireflies storage is capped in MINUTES, not transcript count, so this is what a delete actually reclaims.';
comment on column public.fireflies_transcripts.ghl_note_id is
  'Id of the per-consult GHL contact note. Notes are unlimited per contact and never overwrite, unlike the custom fields.';

-- Deleting from Fireflies is only safe once the text is here. Partial index
-- so the cleanup sweep can cheaply ask "what is safe to delete".
create index if not exists fireflies_transcripts_archived_idx
  on public.fireflies_transcripts (meeting_date)
  where transcript_text is not null;

create index if not exists fireflies_transcripts_contact_idx
  on public.fireflies_transcripts (contact_id, meeting_date desc);
