/**
 * Appointment Webhook Handlers
 * Handles GHL appointment events: Supabase persistence, reschedule detection, push notifications
 */

const { supabase } = require('./supabaseClient');
const apnsService = require('../services/apnsService');

/**
 * Handle appointment created event
 */
async function handleAppointmentCreated(payload) {
  console.log('✅ Processing appointment.created event');

  const appointment = mapGHLAppointmentToSupabase(payload);

  // Set original times once at creation — never overwritten on reschedule
  appointment.original_start_time = appointment.start_time;
  appointment.original_end_time = appointment.end_time;

  const { error } = await supabase
    .from('appointments')
    .insert([appointment]);

  if (error) {
    console.error('❌ Error inserting appointment:', error);
    throw error;
  }

  console.log('✅ Appointment created in Supabase:', appointment.id);

  // Send push notification to assigned artist
  await sendAppointmentPushNotification(payload.appointment || payload, 'created');
}

/**
 * Handle appointment updated event — includes reschedule detection
 */
async function handleAppointmentUpdated(payload) {
  console.log('🔄 Processing appointment.updated event');

  const appointment = mapGHLAppointmentToSupabase(payload);
  const rawAppointment = payload.appointment || payload;

  // Detect if this is a cancellation
  const status = rawAppointment.appointmentStatus || rawAppointment.status;
  const isCancelled = status === 'cancelled' || status === 'Cancelled';

  // --- Reschedule detection: fetch current row before upserting ---
  let isRescheduled = false;

  if (!isCancelled && appointment.id) {
    try {
      const { data: existing, error: fetchError } = await supabase
        .from('appointments')
        .select('start_time, end_time, reschedule_count, reschedule_history, original_start_time, original_end_time')
        .eq('id', appointment.id)
        .single();

      if (fetchError) {
        console.log('⚠️ Could not fetch existing appointment (may be new):', fetchError.message);
      } else if (existing) {
        // Normalize times to ISO strings for comparison
        const existingStart = new Date(existing.start_time).toISOString();
        const incomingStart = new Date(appointment.start_time).toISOString();

        if (existingStart !== incomingStart) {
          isRescheduled = true;
          const now = new Date();
          const previousStart = new Date(existing.start_time);
          const hoursBeforeAppt = (previousStart - now) / (1000 * 60 * 60);

          const historyEntry = {
            rescheduled_at: now.toISOString(),
            previous_start_time: existing.start_time,
            previous_end_time: existing.end_time,
            new_start_time: appointment.start_time,
            new_end_time: appointment.end_time,
            hours_before_appointment: Math.round(hoursBeforeAppt * 10) / 10
          };

          const currentHistory = Array.isArray(existing.reschedule_history)
            ? existing.reschedule_history
            : [];

          // Merge reschedule fields into the upsert payload
          appointment.reschedule_count = (existing.reschedule_count || 0) + 1;
          appointment.reschedule_history = [...currentHistory, historyEntry];

          // Preserve original times — never overwrite them
          if (existing.original_start_time) {
            appointment.original_start_time = existing.original_start_time;
            appointment.original_end_time = existing.original_end_time;
          }

          console.log(`📅 Reschedule detected (#${appointment.reschedule_count}): ${existingStart} → ${incomingStart}`);
        }
      }
    } catch (err) {
      console.error('⚠️ Error during reschedule detection (continuing with upsert):', err.message);
    }
  }

  // --- Upsert (now includes reschedule fields if applicable) ---
  const { error } = await supabase
    .from('appointments')
    .upsert([appointment], { onConflict: 'id' });

  if (error) {
    console.error('❌ Error updating appointment:', error);
    throw error;
  }

  console.log('✅ Appointment updated in Supabase:', appointment.id);

  // Send push notification — use 'rescheduled' when times changed
  let eventType = 'updated';
  if (isCancelled) eventType = 'cancelled';
  else if (isRescheduled) eventType = 'rescheduled';
  await sendAppointmentPushNotification(rawAppointment, eventType);
}

/**
 * Handle appointment deleted event
 */
async function handleAppointmentDeleted(payload) {
  console.log('🗑️ Processing appointment.deleted event');

  const appointmentId = payload.appointment?.id || payload.appointmentId;
  const rawAppointment = payload.appointment || payload;

  const { error } = await supabase
    .from('appointments')
    .delete()
    .eq('id', appointmentId);

  if (error) {
    console.error('❌ Error deleting appointment:', error);
    throw error;
  }

  console.log('✅ Appointment deleted from Supabase:', appointmentId);

  await sendAppointmentPushNotification(rawAppointment, 'cancelled');
}

/**
 * Map GHL appointment payload to Supabase schema
 */
function mapGHLAppointmentToSupabase(payload) {
  const appt = payload.appointment || payload;

  return {
    id: appt.id || payload.appointmentId || appt.appointmentId,
    title: appt.title || 'Consultation',
    calendar_id: appt.calendarId,
    contact_id: appt.contactId,
    location_id: payload.locationId || appt.locationId,
    start_time: appt.startTime,
    end_time: appt.endTime,
    status: appt.appointmentStatus || 'new',
    assigned_user_id: appt.assignedUserId || null,
    address: appt.address || null,
    notes: appt.notes || appt.description || null,
    appointment_type: appt.appointmentType || null,
    ghl_created_at: appt.dateAdded || null,
    ghl_updated_at: appt.dateUpdated || null
  };
}

/**
 * Send push notification to assigned artist when appointment changes
 */
async function sendAppointmentPushNotification(appointment, eventType) {
  if (!apnsService.isConfigured()) {
    console.log('⚠️ APNs not configured, skipping push notification');
    return;
  }

  const assignedUserId = appointment.assignedUserId || appointment.assigned_user_id;

  if (!assignedUserId) {
    console.log('⚠️ No assigned user for appointment, skipping push notification');
    return;
  }

  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('ghl_user_id', assignedUserId)
      .single();

    if (profileError || !profile) {
      console.log(`⚠️ No profile found for GHL user ${assignedUserId}`);
      return;
    }

    const { data: tokens, error: tokenError } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', profile.id)
      .eq('is_active', true);

    if (tokenError) {
      console.error('❌ Error fetching push tokens:', tokenError);
      return;
    }

    if (!tokens || tokens.length === 0) {
      console.log(`⚠️ No push tokens found for user ${profile.id}`);
      return;
    }

    const notification = formatAppointmentNotification(appointment, eventType);

    console.log(`📱 Sending ${eventType} notification to ${tokens.length} device(s)`);

    for (const tokenRecord of tokens) {
      await apnsService.sendWithRefresh(tokenRecord.token, notification);
    }

    console.log('✅ Push notifications sent successfully');

  } catch (error) {
    console.error('❌ Error sending push notification:', error);
  }
}

/**
 * Format appointment notification content based on event type
 */
function formatAppointmentNotification(appointment, eventType) {
  const contactName = appointment.title || appointment.contactName || 'Client';
  const startTime = appointment.startTime || appointment.start_time;

  const date = new Date(startTime);
  const formattedDate = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
  const formattedTime = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  let title = 'Studio AZ';
  let body = '';

  switch (eventType) {
    case 'created':
      title = 'New Appointment';
      body = `${contactName} - ${formattedDate} at ${formattedTime}`;
      break;
    case 'updated':
      body = `Appointment updated: ${contactName} - ${formattedDate} at ${formattedTime}`;
      break;
    case 'cancelled':
      title = 'Appointment Cancelled';
      body = `${contactName} - ${formattedDate} at ${formattedTime}`;
      break;
    case 'rescheduled':
      title = 'Appointment Rescheduled';
      body = `${contactName} - Now ${formattedDate} at ${formattedTime}`;
      break;
    default:
      body = `Appointment: ${contactName} - ${formattedDate} at ${formattedTime}`;
  }

  return {
    title,
    body,
    type: 'appointment_update',
    appointmentId: appointment.id || appointment.appointmentId,
    contactId: appointment.contactId || appointment.contact_id,
    contactName,
    eventType
  };
}

module.exports = {
  handleAppointmentCreated,
  handleAppointmentUpdated,
  handleAppointmentDeleted,
  mapGHLAppointmentToSupabase,
  formatAppointmentNotification,
};
