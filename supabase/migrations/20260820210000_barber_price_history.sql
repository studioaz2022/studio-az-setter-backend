-- Barber price-event ledger (GALLERY_RANKING_PLAN.md Phase 5).
-- One row per observed price change per (calendar, service). The 4 price
-- sources never cascade, so changes are OBSERVED (snapshot-diff detector on
-- barber_service_prices, 6h tick) rather than logged by humans. Sources:
--   baseline — first time the detector saw this calendar/service (old_price null)
--   detector — a live price change caught by the snapshot diff
--   backfill — inferred from transactions.service_price history, hand-reviewed
--   manual   — entered deliberately (corrections, known history)
-- effective_at: when the price took effect (detection time for detector rows —
-- true change time is within one tick; inferred first-dominant date for
-- backfill rows). Server-only table: no RLS by convention.
create table if not exists barber_price_history (
  id           uuid primary key default gen_random_uuid(),
  calendar_id  text not null,
  barber_slug  text not null,
  service_type text not null,
  old_price    numeric,
  new_price    numeric not null,
  effective_at timestamptz not null,
  source       text not null check (source in ('baseline','detector','backfill','manual')),
  detected_at  timestamptz not null default now(),
  notes        text
);

create index if not exists barber_price_history_cal_svc_idx
  on barber_price_history (calendar_id, service_type, effective_at desc);
