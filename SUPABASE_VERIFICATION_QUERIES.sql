-- ═══════════════════════════════════════════════════════════
-- SUPABASE VERIFICATION QUERIES
-- For testing task creation after Square payment
-- Contact ID: cx8QkqBYM13LnXkOvnQl (Leonel Chavez)
-- ═══════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════
-- Query 1: Check for CREATE_TASK events from AI Setter
-- ═══════════════════════════════════════════════════════════

SELECT 
  id,
  event_type,
  contact_id,
  created_at,
  (data->>'taskType') as task_type,
  (data->>'contactName') as contact_name,
  (data->>'type') as type_field
FROM ai_setter_events
WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
  AND event_type = 'create_task'
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC
LIMIT 10;

-- Expected: Should see 1 row (not 6!)
-- task_type should be: "artist_introduction"


-- ═══════════════════════════════════════════════════════════
-- Query 2: Check for actual tasks in Command Center
-- ═══════════════════════════════════════════════════════════

SELECT 
  id,
  type,
  contact_id,
  contact_name,
  status,
  created_at,
  (metadata->>'consultation_type') as consultation_type,
  (metadata->>'tattoo_size') as tattoo_size,
  (metadata->>'card_note') as card_note
FROM command_center_tasks
WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC
LIMIT 10;

-- Expected: Should see 1 row (not 6!)
-- type should be: "artist_introduction"
-- consultation_type should be: "message"
-- card_note should contain: "Consultation via messages"


-- ═══════════════════════════════════════════════════════════
-- Query 3: Count tasks to check for duplicates
-- ═══════════════════════════════════════════════════════════

SELECT 
  contact_id,
  type,
  COUNT(*) as task_count,
  MIN(created_at) as first_created,
  MAX(created_at) as last_created
FROM command_center_tasks
WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY contact_id, type
ORDER BY task_count DESC;

-- Expected: task_count should be 1 (not 6!)


-- ═══════════════════════════════════════════════════════════
-- Query 4: Check all recent events for this contact
-- ═══════════════════════════════════════════════════════════

SELECT 
  event_type,
  COUNT(*) as event_count,
  MIN(created_at) as first_event,
  MAX(created_at) as last_event
FROM ai_setter_events
WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY event_type
ORDER BY event_count DESC;

-- Expected to see:
-- deposit_paid: 1
-- lead_qualified: 1
-- create_task: 1


-- ═══════════════════════════════════════════════════════════
-- Query 5: View full task details (with metadata)
-- ═══════════════════════════════════════════════════════════

SELECT 
  id,
  type,
  contact_id,
  contact_name,
  status,
  created_at,
  updated_at,
  assigned_to,
  metadata
FROM command_center_tasks
WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;


-- ═══════════════════════════════════════════════════════════
-- CLEANUP QUERY (if there are duplicates)
-- ═══════════════════════════════════════════════════════════

-- ONLY RUN THIS IF YOU SEE DUPLICATES AND WANT TO CLEAN THEM UP!
-- This keeps the FIRST task created and deletes the rest

-- DELETE FROM command_center_tasks
-- WHERE id NOT IN (
--   SELECT MIN(id)
--   FROM command_center_tasks
--   WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
--     AND created_at > NOW() - INTERVAL '1 hour'
--   GROUP BY contact_id, type
-- )
-- AND contact_id = 'cx8QkqBYM13LnXkOvnQl'
-- AND created_at > NOW() - INTERVAL '1 hour';

-- (Uncomment the above if you need to clean up duplicates)


-- ═══════════════════════════════════════════════════════════
-- ALTERNATIVE: Check tasks by assigned user (Claudia)
-- ═══════════════════════════════════════════════════════════

SELECT 
  id,
  type,
  contact_name,
  status,
  created_at,
  (metadata->>'consultation_type') as consultation_type
FROM command_center_tasks
WHERE 'Wl24x1ZrucHuHatM0ODD' = ANY(assigned_to)
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;

-- This shows all tasks assigned to Claudia in the last hour

