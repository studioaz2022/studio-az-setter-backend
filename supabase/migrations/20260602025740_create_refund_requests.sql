-- Refund Request Form — Phase 1: create the refund_requests table.
--
-- One row per refund link minted for a contact. Snapshots the original deposit
-- payment + drop-off context at link-generation time so the public form never has
-- to ask identifying questions and the refund still targets the correct payment
-- if the lead's GHL record changes between send and submit.
--
-- See REFUND_REQUEST_FORM_PLAN.md §5 (Form spec → data model) for the field
-- contracts and §6 for the lifecycle this table participates in.

create table if not exists refund_requests (
  id uuid primary key default gen_random_uuid(),

  -- Magic-link token (48-char hex, 192 bits of entropy). Unique by construction.
  token text unique not null,

  -- Contact + opportunity snapshot (frozen at send time).
  contact_id text not null,
  opportunity_id text,
  language text default 'en',

  -- Drop-off stage derived from GHL state + Fireflies (§4). Controls whether
  -- the form shows the consult-quality section. Stored as text + CHECK so we
  -- can add stages later without a type migration.
  drop_off_stage text not null
    check (drop_off_stage in ('pre_consult', 'consult_scheduled', 'post_consult', 'tattoo_booked')),

  -- Snapshot of the original deposit payment (the refund target).
  -- Null on the missing-deposit manual-review branch.
  square_payment_id text,
  refund_amount_cents integer check (refund_amount_cents is null or refund_amount_cents >= 0),
  currency text default 'USD',

  -- Lifecycle status for the request itself (pending → completed/expired).
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'expired')),

  -- Section 1 — main reason (granular, 10-option enum).
  reason_code text
    check (reason_code is null or reason_code in (
      'not_now', 'found_other', 'price', 'scheduling', 'style_fit',
      'design_confidence', 'consult_expectations', 'finances',
      'personal_medical', 'other'
    )),
  reason_other_text text,

  -- Structural Lost analytics (§6.6) — derived on submit from drop_off_stage
  -- and reason_code so a future Lost-Deals dashboard slices cleanly.
  last_stage_before_lost text,
  lost_reason text,
  refund_type text
    check (refund_type is null or refund_type in (
      'deposit_refunded', 'partial_refund', 'no_refund', 'no_payment'
    )),

  -- Section 2 — consult-quality scores (only when drop_off_stage is post-consult).
  -- Stored as jsonb to keep the wide column count down; shape:
  -- { "q_felt_heard": 1..5, "q_style_match": 1..5, "q_price_clarity": 1..5,
  --   "q_next_steps": 1..5, "q_trust": 1..5 }
  consult_scores jsonb,

  -- Section 3 — one open answer.
  improvement_text text,

  -- Section 4 — win-back.
  winback_opt_in boolean,
  winback_earliest_month text,  -- "YYYY-MM" when winback_opt_in is true

  -- Refund outcome (the money side; orthogonal to `status`).
  refund_status text not null default 'not_attempted'
    check (refund_status in ('not_attempted', 'refunded', 'failed', 'manual_review')),
  multi_or_missing_deposit boolean not null default false,
  candidate_payment_ids jsonb,  -- [{ "square_payment_id": "...", "amount_cents": 10000 }, ...]
  consult_validity text
    check (consult_validity is null or consult_validity in ('valid', 'low_signal', 'unknown')),
  square_refund_id text,         -- Square's refund id (distinct from payment id, see plan Phase 0 finding)

  -- E-signature-style audit on submit.
  submitted_ip text,
  submitted_user_agent text,

  -- Timestamps.
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days')
);

-- Lookups by token are the hot path (form load + submit). `unique` on token
-- already builds a btree index, so no extra index needed for that.

-- Lookups for analytics + the multi/missing-deposit ops queue.
create index if not exists idx_refund_requests_contact_id on refund_requests(contact_id);
create index if not exists idx_refund_requests_status on refund_requests(status);
create index if not exists idx_refund_requests_refund_status on refund_requests(refund_status);
create index if not exists idx_refund_requests_created_at on refund_requests(created_at desc);
