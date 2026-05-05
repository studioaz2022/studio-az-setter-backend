-- Prevent duplicate Square payment rows per location.
-- Background: a single Square payment was inserted 5 times when webhook retries
-- raced the application-level dedup check. Adding a partial unique index gives
-- us a final safety net at the DB layer.
--
-- Scoped to (square_payment_id, location_id) so the same payment ID can
-- legitimately exist across distinct merchant locations (tattoo vs barbershop)
-- if Square ever emits the same identifier under different OAuth merchants.
-- Within a single location, a square_payment_id must be unique.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_transactions_square_payment_per_location
  ON transactions (square_payment_id, location_id)
  WHERE square_payment_id IS NOT NULL;
