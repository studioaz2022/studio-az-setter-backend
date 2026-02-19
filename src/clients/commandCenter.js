/**
 * Command Center Task Management
 * Creates and manages tasks in the iOS Command Center via Supabase
 */

const crypto = require('crypto');
const { supabase } = require('./supabaseClient');

// Command Center Task Types (must match iOS TaskType enum - uses snake_case)
const TASK_TYPES = {
  SEND_DESIGN_SKETCH: 'send_design_sketch',
  QUOTE_LEAD: 'quote_lead',
  SCHEDULE_APPOINTMENT: 'schedule_appointment',
  REPLY_TO_CLIENT: 'reply_to_client',
  PRE_CONSULTATION_NOTES: 'pre_consultation_notes',
  POST_CONSULTATION_FOLLOWUP: 'post_consultation_followup',
  DESIGN_CHANGE_REQUEST: 'design_change_request',
  ARTIST_INTRODUCTION: 'artist_introduction',
  FINAL_CHECKLIST: 'final_checklist',
  CUSTOM_FOLLOWUP: 'custom_followup',
  // Route A Admin-Artist Communication
  QUOTE_CONFIRMATION: 'quote_confirmation',
  ADMIN_UPDATE: 'admin_update',
  ARTIST_RESPONSE: 'artist_response',
  // Post-consultation quote verification
  QUOTE_VERIFICATION: 'quote_verification',
};

// Task due intervals in hours
const TASK_DUE_INTERVALS = {
  [TASK_TYPES.SEND_DESIGN_SKETCH]: 24,
  [TASK_TYPES.QUOTE_LEAD]: 24,
  [TASK_TYPES.SCHEDULE_APPOINTMENT]: 24,
  [TASK_TYPES.REPLY_TO_CLIENT]: 12,
  [TASK_TYPES.PRE_CONSULTATION_NOTES]: 2,
  [TASK_TYPES.POST_CONSULTATION_FOLLOWUP]: 4,
  [TASK_TYPES.DESIGN_CHANGE_REQUEST]: 24,
  [TASK_TYPES.ARTIST_INTRODUCTION]: 2,
  [TASK_TYPES.FINAL_CHECKLIST]: 48,
  [TASK_TYPES.CUSTOM_FOLLOWUP]: 24,
  [TASK_TYPES.QUOTE_CONFIRMATION]: 1,
  [TASK_TYPES.ADMIN_UPDATE]: 6,
  [TASK_TYPES.ARTIST_RESPONSE]: 2,
  [TASK_TYPES.QUOTE_VERIFICATION]: 2,
};

/**
 * Creates a Command Center task in Supabase
 */
async function createCommandCenterTask(taskData) {
  const {
    type,
    contactId,
    contactName,
    assignedTo,
    triggerEvent,
    relatedAppointmentId = null,
    relatedConversationId = null,
    targetMessageId = null,
    locationId,
    metadata = {},
    customDueDate = null,
  } = taskData;

  // Calculate due date
  const dueHours = TASK_DUE_INTERVALS[type] || 24;
  const dueAt = customDueDate || new Date(Date.now() + dueHours * 60 * 60 * 1000);

  const task = {
    id: crypto.randomUUID(),
    type: type,
    contact_id: contactId,
    contact_name: contactName,
    assigned_to: assignedTo,
    created_by: 'system',
    created_at: new Date().toISOString(),
    due_at: dueAt.toISOString(),
    status: 'pending',
    urgency_level: 'normal',
    trigger_event: triggerEvent,
    related_appointment_id: relatedAppointmentId,
    related_conversation_id: relatedConversationId,
    target_message_id: targetMessageId,
    requires_all_assignees: false,
    metadata: metadata,
    location_id: locationId,
  };

  const { error } = await supabase
    .from('command_center_tasks')
    .insert([task]);

  if (error) {
    console.error('❌ Error creating Command Center task:', error);
    throw error;
  }

  console.log(`✅ Command Center task created: ${type} for ${contactName}`);
  return task;
}

/**
 * Check if a similar task already exists (to prevent duplicates)
 */
async function taskExists(type, contactId, triggerEvent) {
  const { data, error } = await supabase
    .from('command_center_tasks')
    .select('id')
    .eq('type', type)
    .eq('contact_id', contactId)
    .eq('trigger_event', triggerEvent)
    .in('status', ['pending', 'overdue', 'urgent'])
    .limit(1);

  if (error) {
    console.error('❌ Error checking for existing task:', error);
    return false;
  }

  return data && data.length > 0;
}

/**
 * Get contact info from Supabase contacts table
 */
async function getContactInfo(contactId) {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, assigned_to, location_id')
    .eq('id', contactId)
    .single();

  if (error) {
    console.log(`ℹ️ Could not fetch contact info for ${contactId}:`, error.message);
    return null;
  }

  return data;
}

module.exports = {
  TASK_TYPES,
  TASK_DUE_INTERVALS,
  createCommandCenterTask,
  taskExists,
  getContactInfo,
};
