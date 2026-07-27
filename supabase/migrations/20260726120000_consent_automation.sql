-- Consent Form Automation — 24h pre-appointment sweep state store.
--
-- One row per tattoo appointment that the automation has evaluated. This table
-- is the idempotency + debounce guard: it is what stops a redeploy mid-sweep
-- from re-texting a client or spawning a duplicate Command Center task.
--
-- Keyed by appointment_id (GHL appointment IDs are stable across reschedules,
-- the same invariant consent_forms already relies on).
--
-- Server-only table (backend service role) — no RLS, per workspace convention.

create table if not exists consent_automation (
  appointment_id      text primary key,
  contact_id          text not null,
  calendar_id         text,
  artist_name         text,
  artist_ghl_user_id  text,
  appointment_start   timestamptz,

  -- State machine:
  --   pending           discovered, not yet acted on
  --   sent              consent form sent (terminal, success)
  --   sending           claim written, SMS in flight
  --   send_failed       send errored, retry on a later tick (attempt_count < 3)
  --   send_abandoned    3 failed attempts, gave up (day-of reminder is the net)
  --   task_created      fields missing, Command Center task open
  --   skipped_has_form  a consent form already existed for this appointment
  --   skipped_no_phone  contact has no phone; task created so the artist can fix
  --   closed_cancelled  appointment cancelled after we created a task
  state               text not null default 'pending',

  missing_fields      jsonb,
  cc_task_id          uuid,
  task_created_at     timestamptz,
  sent_claimed_at     timestamptz,
  sent_at             timestamptz,
  sent_via            text,
  hold_until          timestamptz,
  attempt_count       integer not null default 0,
  last_error          text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_consent_automation_state
  on consent_automation (state);

create index if not exists idx_consent_automation_contact
  on consent_automation (contact_id);

create index if not exists idx_consent_automation_cc_task
  on consent_automation (cc_task_id);
