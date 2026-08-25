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
    let notifType; // captured for logging (notification may be a localizer function)

    for (const tokenRecord of tokens) {
      try {
        // Localize notification if needed
        const localizedNotification = typeof notification === 'function'
          ? notification(tokenRecord.language)
          : notification;
        notifType = localizedNotification.type;
        await apnsService.send(tokenRecord.token, localizedNotification);
        sent++;
      } catch (err) {
        console.error(`❌ [TASK APN] Failed to send to token: ${err.message}`);
        failed++;
      }
    }

    // Log the resolved type, not `notification.type` — when notification is a
    // localizer function that read `undefined` and hid the real type.
    console.log(`📱 [TASK APN] ${notifType || 'unknown'}: sent to ${sent} device(s) for GHL user ${ghlUserId}`);
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
async function sendTaskAssignedNotification({ assigneeGhlUserId, creatorGhlUserId, creatorName, contactName, contactId, taskNote, taskId }) {
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
      // contactId lets the app deep-link the tap straight to the client (previously
      // hardcoded null, so tapping dumped the user on a generic screen — the "I got
      // a notification but the app showed nothing" bug).
      contactId: contactId || null,
      taskId: taskId || null,
    };
  };

  const result = await sendPushToGhlUser(assigneeGhlUserId, notification);
  // Record the outcome on the DB trigger's notification_queue row so the
  // ledger stays honest for iOS-created tasks too (they push via this
  // endpoint, not via createCommandCenterTask).
  if (taskId) await markTaskPushLedger(taskId, assigneeGhlUserId, result);
  return result;
}

/**
 * Mark the notification_queue row that the command_center_tasks DB trigger
 * wrote for (taskId, assignee) with the real APNs outcome. The queue was
 * designed as a push pipeline but nothing ever drained it — every row sat
 * 'pending' forever while pushes (when they happened at all) went out through
 * other paths. Delivery now happens at task creation; the queue survives
 * purely as the delivery LEDGER, and this is the only writer that moves rows
 * out of 'pending'.
 *
 * Notes:
 *  - queue user_id holds the GHL user ID (not a profile UUID) — that mismatch
 *    is why the old /api/notifications/pending join could never find tokens.
 *  - iOS sends uppercase UUIDs (Swift uuidString), the trigger stores
 *    lowercase — ilike (no wildcards) gives case-insensitive equality.
 *  - Best-effort: a ledger write must never break a push path.
 */
async function markTaskPushLedger(taskId, assigneeGhlUserId, result) {
  try {
    const delivered = result && result.sent > 0;
    const update = delivered
      ? { status: 'sent', sent_at: new Date().toISOString(), attempts: 1 }
      : { status: 'failed', attempts: 1, error_message: 'no profile / no active push tokens / APNs send failed' };

    await supabase
      .from('notification_queue')
      .update(update)
      .eq('user_id', assigneeGhlUserId)
      .eq('status', 'pending')
      .ilike('data->>taskId', String(taskId));
  } catch (err) {
    console.error(`⚠️ [TASK APN] Ledger update failed for task ${taskId}:`, err.message);
  }
}

/**
 * Notify the task creator that the assignee completed the task.
 * Only sends if the completer is different from the creator.
 */
async function sendTaskCompletedNotification({ creatorGhlUserId, completerGhlUserId, completerName, contactName, contactId, taskId }) {
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
      contactId: contactId || null,
      taskId: taskId || null,
    };
  };

  return sendPushToGhlUser(creatorGhlUserId, notification);
}

/**
 * Notify assignee that their task is now overdue.
 */
async function sendTaskOverdueNotification({ assigneeGhlUserId, contactName, contactId, taskId }) {
  const notification = (language) => {
    const isSpanish = language === 'es';
    return {
      type: 'task_overdue',
      title: isSpanish ? 'Tarea Vencida' : 'Task Overdue',
      body: isSpanish
        ? `Tu seguimiento con ${contactName} está vencido`
        : `Your follow-up with ${contactName} is overdue`,
      contactId: contactId || null,
      taskId: taskId || null,
    };
  };

  return sendPushToGhlUser(assigneeGhlUserId, notification);
}

/**
 * Notify assignee that their task has escalated to urgent.
 */
async function sendTaskUrgentNotification({ assigneeGhlUserId, contactName, contactId, taskId }) {
  const notification = (language) => {
    const isSpanish = language === 'es';
    return {
      type: 'task_urgent',
      title: isSpanish ? 'Tarea Urgente' : 'Urgent Task',
      body: isSpanish
        ? `El seguimiento con ${contactName} necesita atención inmediata`
        : `Follow-up with ${contactName} needs immediate attention`,
      contactId: contactId || null,
      taskId: taskId || null,
    };
  };

  return sendPushToGhlUser(assigneeGhlUserId, notification);
}

module.exports = {
  sendPushToGhlUser,
  markTaskPushLedger,
  sendTaskAssignedNotification,
  sendTaskCompletedNotification,
  sendTaskOverdueNotification,
  sendTaskUrgentNotification,
};
