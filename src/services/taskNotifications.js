/**
 * Task Push Notification Service
 * Sends APNs push notifications for Command Center task events:
 * - task_assigned: Notifies assignee when someone creates/assigns a task to them
 * - task_completed: Notifies task creator when the assignee completes the task
 * - task_overdue: Notifies assignee when their task becomes overdue
 * - task_urgent: Notifies assignee when their task escalates to urgent
 */

const { supabase } = require('../clients/supabaseClient');
const apnsService = require('./apnsService');

/**
 * Send push notification to a GHL user by their GHL user ID.
 * Looks up their Supabase profile, fetches active push tokens, and sends via APNs.
 * @param {string} ghlUserId - GHL user ID of the recipient
 * @param {object} notification - { type, title, body, contactId?, taskId? }
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function sendPushToGhlUser(ghlUserId, notification) {
  if (!apnsService.isConfigured()) {
    console.log('⚠️ [TASK APN] APNs not configured, skipping');
    return { sent: 0, failed: 0 };
  }

  if (!ghlUserId) {
    return { sent: 0, failed: 0 };
  }

  try {
    // Map GHL user ID to Supabase profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('ghl_user_id', ghlUserId)
      .single();

    if (profileError || !profile) {
      console.log(`⚠️ [TASK APN] No profile found for GHL user ${ghlUserId}`);
      return { sent: 0, failed: 0 };
    }

    // Fetch active push tokens
    const { data: tokens, error: tokenError } = await supabase
      .from('push_tokens')
      .select('token, language')
      .eq('user_id', profile.id)
      .eq('is_active', true);

    if (tokenError || !tokens || tokens.length === 0) {
      console.log(`⚠️ [TASK APN] No active tokens for user ${ghlUserId}`);
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;

    for (const tokenRecord of tokens) {
      try {
        // Localize notification if needed
        const localizedNotification = typeof notification === 'function'
          ? notification(tokenRecord.language)
          : notification;
        await apnsService.send(tokenRecord.token, localizedNotification);
        sent++;
      } catch (err) {
        console.error(`❌ [TASK APN] Failed to send to token: ${err.message}`);
        failed++;
      }
    }

    console.log(`📱 [TASK APN] ${notification.type}: sent to ${sent} device(s) for GHL user ${ghlUserId}`);
    return { sent, failed };
  } catch (error) {
    console.error('❌ [TASK APN] Error:', error.message || error);
    return { sent: 0, failed: 0 };
  }
}

/**
 * Notify assignee that a task has been assigned to them.
 * Only sends if the assignee is different from the creator (don't notify yourself).
 */
async function sendTaskAssignedNotification({ assigneeGhlUserId, creatorGhlUserId, creatorName, contactName, taskNote, taskId }) {
  // Don't notify if you assigned the task to yourself
  if (assigneeGhlUserId === creatorGhlUserId) {
    console.log(`📱 [TASK APN] Skipping self-assignment notification`);
    return { sent: 0, failed: 0 };
  }

  const notePreview = taskNote && taskNote.length > 80
    ? taskNote.substring(0, 80) + '...'
    : taskNote;

  const notification = (language) => {
    const isSpanish = language === 'es';
    return {
      type: 'task_assigned',
      title: isSpanish ? `Nueva Tarea de ${creatorName}` : `New Task from ${creatorName}`,
      body: notePreview || (isSpanish ? `Seguimiento con ${contactName}` : `Follow up with ${contactName}`),
      contactId: null,
      taskId: taskId || null,
    };
  };

  return sendPushToGhlUser(assigneeGhlUserId, notification);
}

/**
 * Notify the task creator that the assignee completed the task.
 * Only sends if the completer is different from the creator.
 */
async function sendTaskCompletedNotification({ creatorGhlUserId, completerGhlUserId, completerName, contactName, taskId }) {
  // Don't notify if you completed your own task
  if (creatorGhlUserId === completerGhlUserId) {
    console.log(`📱 [TASK APN] Skipping self-completion notification`);
    return { sent: 0, failed: 0 };
  }

  const notification = (language) => {
    const isSpanish = language === 'es';
    return {
      type: 'task_completed',
      title: isSpanish ? 'Tarea Completada' : 'Task Completed',
      body: isSpanish
        ? `${completerName} completó el seguimiento con ${contactName}`
        : `${completerName} completed the follow-up with ${contactName}`,
      contactId: null,
      taskId: taskId || null,
    };
  };

  return sendPushToGhlUser(creatorGhlUserId, notification);
}

/**
 * Notify assignee that their task is now overdue.
 */
async function sendTaskOverdueNotification({ assigneeGhlUserId, contactName, taskId }) {
  const notification = (language) => {
    const isSpanish = language === 'es';
    return {
      type: 'task_overdue',
      title: isSpanish ? 'Tarea Vencida' : 'Task Overdue',
      body: isSpanish
        ? `Tu seguimiento con ${contactName} está vencido`
        : `Your follow-up with ${contactName} is overdue`,
      contactId: null,
      taskId: taskId || null,
    };
  };

  return sendPushToGhlUser(assigneeGhlUserId, notification);
}

/**
 * Notify assignee that their task has escalated to urgent.
 */
async function sendTaskUrgentNotification({ assigneeGhlUserId, contactName, taskId }) {
  const notification = (language) => {
    const isSpanish = language === 'es';
    return {
      type: 'task_urgent',
      title: isSpanish ? 'Tarea Urgente' : 'Urgent Task',
      body: isSpanish
        ? `El seguimiento con ${contactName} necesita atención inmediata`
        : `Follow-up with ${contactName} needs immediate attention`,
      contactId: null,
      taskId: taskId || null,
    };
  };

  return sendPushToGhlUser(assigneeGhlUserId, notification);
}

module.exports = {
  sendPushToGhlUser,
  sendTaskAssignedNotification,
  sendTaskCompletedNotification,
  sendTaskOverdueNotification,
  sendTaskUrgentNotification,
};
