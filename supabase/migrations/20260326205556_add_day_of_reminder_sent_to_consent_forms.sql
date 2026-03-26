-- Add day_of_reminder_sent column to consent_forms table
-- Used to track whether a day-of reminder SMS has been sent to avoid duplicates
ALTER TABLE consent_forms
ADD COLUMN IF NOT EXISTS day_of_reminder_sent boolean DEFAULT false;
