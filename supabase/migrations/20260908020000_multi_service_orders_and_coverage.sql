-- Let one payment legitimately cover several appointments.
--
-- A parent paying for their kids is routine here, and until now it looked like
-- a defect: one appointment "overpaid", the sibling reading unpaid. Two real
-- examples, both confirmed against the live Square API on 2026-09-08:
--
--   Heidi Girod, Sep 4      — $92.00  = order with TWO "Haircut" line items,
--                             $40 + $40, for her two sons.
--   Matthew Walters, Aug 28 — $162.50 = order with TWO line items, a $65
--                             catalog "Haircut" plus a $60 custom amount, for
--                             himself and his son.
--
-- Square knew all along. Two things stopped us seeing it:
--
--   1. fetchSquareOrderDetails() read only `order.line_items[0]` and discarded
--      the rest, so a two-haircut order was indistinguishable from a one-haircut
--      one.
--   2. assignUnmatchedPayment() never stored square_order_id, so 411 of 1,197
--      Square rows have no order to go back and look at. Both payments above
--      were in that group — the id existed on the payment, we just dropped it.
--
-- order_line_items keeps the whole array so the evidence survives; the money
-- stays on ONE transaction row, because splitting it across rows would be the
-- easiest possible way to double-count revenue.
--
-- appointments.payment_covered_by records the other side: this appointment was
-- paid for by that transaction. The appointment leaves the attendance queue
-- without inventing a payment for it.

alter table public.transactions
  add column if not exists order_line_items   jsonb,
  add column if not exists service_item_count integer;

comment on column public.transactions.order_line_items is
  'Every line item on the Square order, not just the first. A payment ringing up two haircuts is how a parent paying for their kids actually appears, and it is the only reliable evidence that one payment covers more than one appointment.';

comment on column public.transactions.service_item_count is
  'Count of non-product line items on the order. >1 means this payment covers multiple services.';

alter table public.appointments
  add column if not exists payment_covered_by text;

comment on column public.appointments.payment_covered_by is
  'Transaction id of a payment that covers this appointment as well as its own. Used when one person pays for several people — the money stays on ONE transaction row so totals cannot double-count, and this records the link.';
