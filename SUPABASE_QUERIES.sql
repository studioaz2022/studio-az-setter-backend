-- ============================================================================
-- SUPABASE QUERIES: Check Task Creation
-- ============================================================================

-- Query 1: Check for CREATE_TASK events in ai_setter_events table
-- This shows if the webhook server received the CREATE_TASK event
SELECT
  id,
  event_type,
  contact_id,
  event_data,
  created_at
FROM ai_setter_events
WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
AND event_type = 'create_task'
ORDER BY created_at DESC
LIMIT 5;

-- Query 2: Check for all tasks created for this contact
-- This shows all tasks regardless of type
SELECT
  id,
  type,
  contact_id,
  contact_name,
  assigned_to,
  status,
  trigger_event,
  metadata,
  created_at
FROM command_center_tasks
WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
AND trigger_event = 'deposit_paid'
ORDER BY created_at DESC
LIMIT 5;

-- Query 3: Check specifically for artist_introduction tasks
-- This is what we expect to see for message consultations
SELECT
  id,
  type,
  contact_name,
  assigned_to,
  status,
  trigger_event,
  metadata->>'consultation_type' as consultation_type,
  metadata->>'tattoo_size' as tattoo_size,
  metadata->>'reason' as reason,
  metadata->>'route' as route,
  created_at
FROM command_center_tasks
WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
AND type = 'artist_introduction'
ORDER BY created_at DESC
LIMIT 1;

-- Query 4: Check all recent tasks for Claudia (assigned_to contains her GHL user ID)
-- This shows what tasks Claudia should see in the iOS app
SELECT
  id,
  type,
  contact_name,
  assigned_to,
  status,
  trigger_event,
  metadata,
  created_at
FROM command_center_tasks
WHERE 'Wl24x1ZrucHuHatM0ODD' = ANY(assigned_to)
AND status IN ('pending', 'overdue', 'urgent')
ORDER BY created_at DESC
LIMIT 10;

-- Query 5: Check if task was created but with wrong contact_id
-- Sometimes contact IDs might be slightly different
SELECT
  id,
  type,
  contact_id,
  contact_name,
  assigned_to,
  status,
  trigger_event,
  created_at
FROM command_center_tasks
WHERE contact_name ILIKE '%Leonel%'
OR contact_name ILIKE '%Chavez%'
ORDER BY created_at DESC
LIMIT 5;

