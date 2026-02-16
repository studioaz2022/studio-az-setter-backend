-- Fireflies.ai Backup Transcription Integration
-- Run this migration against your Supabase database

-- 1. Add columns to meet_event_subscriptions for Fireflies matching
ALTER TABLE meet_event_subscriptions
  ADD COLUMN IF NOT EXISTS calendar_event_title TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMPTZ;

-- 2. Create fireflies_transcripts table for tracking processed transcripts
CREATE TABLE IF NOT EXISTS fireflies_transcripts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  transcript_id TEXT NOT NULL UNIQUE,
  contact_id TEXT,
  meeting_title TEXT,
  meeting_date TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | processed | skipped_google_exists | unmatched | deleted
  processed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ff_status_created ON fireflies_transcripts (status, created_at);
