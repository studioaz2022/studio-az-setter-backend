-- Forensic audit trail: one row per important state-changing action, stamped with
-- the signed-in user who performed it (attribution GHL loses via the shared token).
-- Written directly by the iOS app (AuditService). Append-only.
CREATE TABLE IF NOT EXISTS public.audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_ghl_id  text,                     -- GHL user id of the signed-in user who acted
  actor_name    text NOT NULL,            -- display name at time of action
  actor_role    text,                     -- owner/admin/artist
  action        text NOT NULL,            -- appointment.book, appointment.reschedule, quote.set, contact.reassign, ...
  target_type   text NOT NULL,            -- appointment / contact / quote / task
  target_id     text,                     -- GHL appointment id, contact id, etc.
  contact_id    text,                     -- denormalized for easy per-contact history
  summary       text NOT NULL,            -- human-readable one-liner
  details       jsonb,                    -- structured before/after + extra context
  location_id   text,
  source        text NOT NULL DEFAULT 'ios',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_contact_id_idx ON public.audit_events (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_target_id_idx  ON public.audit_events (target_id);
CREATE INDEX IF NOT EXISTS audit_events_action_idx     ON public.audit_events (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx      ON public.audit_events (actor_ghl_id, created_at DESC);

-- Append-only: RLS on, allow insert + read, but NOT update/delete (immutable trail).
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all insert on audit_events"
  ON public.audit_events FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "Allow all select on audit_events"
  ON public.audit_events FOR SELECT TO public USING (true);
