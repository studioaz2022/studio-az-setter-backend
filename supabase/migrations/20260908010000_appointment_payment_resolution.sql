-- Somewhere to answer "this appointment has no payment — why?"
--
-- Measured Jun 1 - Sep 5 2026: attendance items run 0.86 per barber-day and are
-- the single biggest source of review noise — 55 of 120 barber-days had an
-- appointment with no payment and no spare money anywhere on the day. They are
-- also unanswerable from the data alone: appointment status carries no
-- attendance signal at all (all 627 past appointments sat at `confirmed`, zero
-- at `showed`, six at `noshow` in three months), so nothing can tell cash apart
-- from a comp or an unmarked no-show.
--
-- Only a person knows. This gives them one place to say it once, so the same
-- appointment stops being raised every single sweep.
--
-- Deliberately NOT written back to GHL in this pass. Setting appointment status
-- there means editAppointment, which requires assignedUserId + calendarId and
-- resets omitted fields — a known foot-gun in this codebase. Syncing the
-- no-show answer upstream is worth doing, and worth doing carefully, separately.

alter table public.appointments
  add column if not exists payment_resolution     text,
  add column if not exists payment_resolved_at    timestamptz,
  add column if not exists payment_resolved_by    text;

comment on column public.appointments.payment_resolution is
  'How an appointment with no linked payment was settled: cash | noshow | comp. Null = still an open attendance question. Set null to reopen.';
comment on column public.appointments.payment_resolved_at is
  'When the attendance question was answered.';
comment on column public.appointments.payment_resolved_by is
  'GHL user id of whoever answered it, or "auto:<rule>".';

create index if not exists appointments_unresolved_idx
  on public.appointments (assigned_user_id, start_time)
  where payment_resolution is null and status = 'confirmed';
