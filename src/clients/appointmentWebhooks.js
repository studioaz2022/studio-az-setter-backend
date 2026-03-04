/**
 * Appointment Webhook Handlers
 * Handles GHL appointment events: Supabase persistence, reschedule detection, push notifications
 */

const { supabase } = require('./supabaseClient');
const apnsService = require('../services/apnsService');
const { createGoogleMeet } = require('./googleMeet');
const { subscribeToMeetSpace } = require('./workspaceEvents');
const {
  CALENDARS,
  CONSULTATION_CALENDARS,
  TRANSLATOR_CALENDARS,
  GHL_USER_EMAILS,
} = require('../config/constants');
const { updateContact } = require('./ghlClient');

// All consultation-related calendar IDs (artist + translator calendars)
const ALL_CONSULT_CALENDAR_IDS = new Set([
  ...Object.values(CALENDARS).filter(Boolean),
  ...Object.values(CONSULTATION_CALENDARS).filter(Boolean),
  ...Object.values(TRANSLATOR_CALENDARS).filter(Boolean),
]);

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

  // Auto-create Google Calendar event + Fireflies for consultation appointments
  // that don't already have a Google Meet link (i.e., manually booked via iOS or GHL UI)
  const rawAppt = payload.appointment || payload;
  await ensureGoogleMeetForConsultation(rawAppt);
}

/**
 * For consultation appointments that lack a Google Meet link,
 * create a Google Calendar event (with Fireflies bot) and
 * a Workspace Events subscription for artifact push notifications.
 *
 * This catches manually-booked consultations from the iOS app or GHL UI
 * that bypass the AI setter's bookingController.
 */
async function ensureGoogleMeetForConsultation(rawAppt) {
  const calendarId = rawAppt.calendarId;
  const contactId = rawAppt.contactId;
  const title = rawAppt.title || 'Consultation';
  const startTime = rawAppt.startTime;
  const endTime = rawAppt.endTime;
  const existingAddress = rawAppt.address || '';
  const assignedUserId = rawAppt.assignedUserId;

  // Only process consultation calendars (skip tattoo session, barbershop, etc.)
  if (!ALL_CONSULT_CALENDAR_IDS.has(calendarId)) {
    return;
  }

  // Skip translator-only appointments (they'll share the artist's Meet link)
  const isTranslatorCalendar = Object.values(TRANSLATOR_CALENDARS).includes(calendarId);
  if (isTranslatorCalendar) {
    console.log('📹 Skipping Google Meet for translator appointment (shares artist link)');
    return;
  }

  // Skip if already has a Google Meet link (AI setter already handled it)
  if (existingAddress && existingAddress.includes('meet.google.com')) {
    console.log('📹 Appointment already has Google Meet link — skipping');
    return;
  }

  console.log(`📹 Consultation appointment on calendar ${calendarId} has no Google Meet — creating one`);

  try {
    // Build attendee list
    const attendeeEmails = [];
    if (assignedUserId && GHL_USER_EMAILS[assignedUserId]) {
      attendeeEmails.push(GHL_USER_EMAILS[assignedUserId]);
    }

    // Fetch contact email if available
    try {
      const { getContact } = require('./ghlClient');
      const contact = await getContact(contactId);
      if (contact?.email) {
        attendeeEmails.push(contact.email);
      }
    } catch (contactErr) {
      console.warn('📹 Could not fetch contact email (non-blocking):', contactErr.message);
    }

    const meetResp = await createGoogleMeet({
      summary: title,
      description: `Consultation booked via GHL\nContact: ${contactId}`,
      startISO: startTime,
      endISO: endTime,
      attendees: attendeeEmails,
    });

    const meetUrl = meetResp.meetUrl || meetResp.htmlLink || null;
    console.log('📹 Google Meet created for manual consultation:', meetUrl);

    if (meetUrl) {
      // Update GHL appointment address + contact custom field with Meet link
      try {
        await updateContact(contactId, {
          customField: { google_meet_link: meetUrl },
        });
        console.log('📹 Updated contact google_meet_link custom field');
      } catch (cfErr) {
        console.warn('📹 Failed to update contact Meet link (non-blocking):', cfErr.message);
      }

      // Subscribe to Workspace Events for real-time artifact notifications
      try {
        await subscribeToMeetSpace(meetUrl, contactId, {
          calendarEventTitle: title,
          scheduledStart: startTime,
          scheduledEnd: endTime,
        });
      } catch (subErr) {
        console.warn('📹 Failed to subscribe to workspace events (non-blocking):', subErr.message);
      }
    }
  } catch (err) {
    // Non-blocking — appointment was already created successfully
    console.error('📹 Failed to create Google Meet for consultation (non-blocking):', err.message);
  }
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

/**
 * Send push notification to assigned owner AND followers when a new inbound message arrives.
 * Sends to both the contact's assignedTo user and any followers.
 */
async function sendMessagePushNotification(contactId, contactName, messageText, assignedUserId, followers, locationId) {
  if (!apnsService.isConfigured()) {
    return;
  }

  if (!assignedUserId && (!followers || followers.length === 0)) {
    return;
  }

  // Tattoo shop location — followers get APNs too
  // Barbershop — only the owner gets APNs (followers can still see conversations in-app)
  const TATTOO_SHOP_LOCATION = 'mUemx2jG4wly4kJWBkI4';
  const includeFollowers = locationId === TATTOO_SHOP_LOCATION;

  try {
    // Collect GHL user IDs to notify
    const ghlUserIds = new Set();
    if (assignedUserId) ghlUserIds.add(assignedUserId);
    if (includeFollowers && followers && Array.isArray(followers)) {
      followers.forEach(id => ghlUserIds.add(id));
    }

    // Look up all profiles for these GHL users
    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select('id, ghl_user_id')
      .in('ghl_user_id', Array.from(ghlUserIds));

    if (profileError || !profiles || profiles.length === 0) {
      console.log(`⚠️ [MSG APN] No profiles found for GHL users ${Array.from(ghlUserIds).join(', ')}`);
      return;
    }

    // Fetch active push tokens for all matched profiles
    const profileIds = profiles.map(p => p.id);
    const { data: tokens, error: tokenError } = await supabase
      .from('push_tokens')
      .select('token, user_id')
      .in('user_id', profileIds)
      .eq('is_active', true);

    if (tokenError || !tokens || tokens.length === 0) {
      return;
    }

    // Truncate message preview for notification body
    const preview = messageText.length > 100
      ? messageText.substring(0, 100) + '...'
      : messageText;

    const notification = {
      type: 'new_message',
      title: contactName || 'New Message',
      body: preview || 'You have a new message',
      contactId,
    };

    const followerNote = includeFollowers ? `+ ${(followers || []).length} follower(s)` : 'owner only';
    console.log(`📱 [MSG APN] Sending to ${tokens.length} device(s) for ${contactName} (${followerNote})`);

    for (const tokenRecord of tokens) {
      await apnsService.sendWithRefresh(tokenRecord.token, notification);
    }
  } catch (error) {
    console.error('❌ [MSG APN] Error sending push notification:', error.message || error);
  }
}

module.exports = {
  handleAppointmentCreated,
  handleAppointmentUpdated,
  handleAppointmentDeleted,
  mapGHLAppointmentToSupabase,
  formatAppointmentNotification,
  sendMessagePushNotification,
};
