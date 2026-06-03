-- Add `environment` to checkout_sessions so a session knows which Square account it belongs to
-- (production vs sandbox). Sandbox sessions are created only for allowlisted test contacts so the
-- team can pay a real test-card deposit end-to-end without touching live money. processCheckoutPayment
-- and the checkout frontend read this to charge / tokenize on the matching Square account.
--
-- Default 'production' keeps every existing + future non-sandbox session behaving exactly as before.
-- Safe to apply anytime; the backend only WRITES this column once SQUARE_SANDBOX_* env vars are set.

alter table if exists checkout_sessions
  add column if not exists environment text not null default 'production';
