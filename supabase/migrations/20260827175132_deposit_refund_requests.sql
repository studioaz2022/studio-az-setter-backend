-- Deposit refund approval — one row per cancelled appointment that has a
-- Square deposit attached. See BARBER_REFUND_APPROVAL_PLAN.md.
--
-- Lionel approves each refund from the iOS Tools tab; nothing here ever refunds
-- on its own. The row is both the work item and the idempotency guard: the
-- unique index on square_payment_id is what stops a replayed cancellation
-- webhook (GHL retries freely) from queueing a second refund for money that was
-- only ever taken once.
--
-- Server-only table (backend service role) — no RLS, per workspace convention.

create table if not exists deposit_refund_requests (
  id                    uuid primary key default gen_random_uuid(),

  -- What was cancelled
  appointment_id        text not null,
  contact_id            text not null,
  contact_name          text,
  calendar_id           text not null,
  service_label         text,

  -- The money. transaction_id points at the original `transactions` deposit row;
  -- square_payment_id is the payment we would refund.
  transaction_id        uuid,
  square_payment_id     text not null,
  deposit_cents         integer not null check (deposit_cents > 0),

  -- The two timestamps the band derives from, plus the derived notice.
  -- notice_minutes is COMPUTED ONCE AND STORED on purpose: the band must reflect
  -- how much warning the client actually gave, not how long the request has sat
  -- in the queue. Recomputing it at approval time would silently downgrade an
  -- honest cancellation into "under 12 hours" just because Lionel took a day to
  -- look at it.
  appointment_start     timestamptz not null,
  cancelled_at          timestamptz not null,
  notice_minutes        integer not null,

  band                  text not null check (band in ('over_24h', '12_to_24h', 'under_12h')),
  recommended_cents     integer not null check (recommended_cents >= 0),

  -- Square's processing fee. fee_is_estimate = true means the payment had not
  -- settled yet and we fell back to the published rate (2.9% + 30c, verified
  -- against this account 2026-08-27); a backfill replaces it once Square knows.
  fee_cents             integer,
  fee_is_estimate       boolean not null default false,

  -- pending    → awaiting Lionel
  -- processing → claimed, Square call in flight (see the claim-before-charge rule)
  -- refunded   → money returned (terminal)
  -- declined   → Lionel said no (terminal)
  -- failed     → Square rejected it; retryable back to pending
  status                text not null default 'pending'
                          check (status in ('pending', 'processing', 'refunded', 'declined', 'failed')),

  approved_cents        integer check (approved_cents >= 0),
  approved_at           timestamptz,
  declined_at           timestamptz,

  square_refund_id      text,
  refund_transaction_id uuid,
  error                 text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- One request per payment, ever. This is the replay guard.
create unique index if not exists deposit_refund_requests_payment_uniq
  on deposit_refund_requests (square_payment_id);

-- Secondary guard: a single appointment can only ever queue one request.
create unique index if not exists deposit_refund_requests_appointment_uniq
  on deposit_refund_requests (appointment_id);

-- The app's list view: pending first, newest first.
create index if not exists deposit_refund_requests_status_idx
  on deposit_refund_requests (status, created_at desc);

comment on table deposit_refund_requests is
  'Barbershop deposit refunds awaiting owner approval in the iOS Tools tab. Never auto-refunds.';
comment on column deposit_refund_requests.notice_minutes is
  'Computed once at creation. Never recompute — the band reflects the client''s notice, not queue age.';
