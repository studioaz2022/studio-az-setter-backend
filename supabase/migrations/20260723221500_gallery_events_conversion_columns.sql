-- Conversion enrichment for gallery_events (Phase 4 wiring):
-- is_new_client — GHL upsert said the contact didn't exist before this booking
-- lead_source   — first-touch source captured on the website (Phase 2)
--
-- NOTE: applied to prod 2026-07-23 via Supabase MCP (apply_migration
-- "gallery_events_conversion_columns"). Idempotent for a future db push.
alter table gallery_events add column if not exists is_new_client boolean;
alter table gallery_events add column if not exists lead_source text;
