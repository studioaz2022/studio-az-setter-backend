/**
 * AI Setter Event Handler
 * Processes events that were previously sent over HTTP from the setter backend
 * to the webhook server. Now called directly as function calls.
 */

const { supabase } = require('./supabaseClient');
const { createCommandCenterTask, taskExists, getContactInfo, TASK_TYPES } = require('./commandCenter');
const { GHL_USER_IDS, GHL_CUSTOM_FIELD_IDS } = require('../config/constants');

// Admin consultation calendar IDs (Maria and Lionel handle consultations independently)
const ADMIN_CONSULTATION_CALENDARS = [
  process.env.GHL_CALENDAR_MARIA || 'LMIAfVnFU7phKTXoIuse',
  process.env.GHL_CALENDAR_LIONEL || 'mmLWt370a94tbaNQIgNw',
];

// AI Setter Event Types
const AI_SETTER_EVENT_TYPES = {
  DEPOSIT_PAID: 'deposit_paid',
  LEAD_QUALIFIED: 'lead_qualified',
  APPOINTMENT_BOOKED: 'appointment_booked',
  PHASE_CHANGED: 'phase_changed',
  LEAD_ASSIGNED: 'lead_assigned',
  CONSULTATION_SCHEDULED: 'consultation_scheduled',
  CONSULTATION_ENDED: 'consultation_ended',
  LEAD_DISQUALIFIED: 'lead_disqualified',
  HUMAN_HANDOFF: 'human_handoff',
  INBOUND_MESSAGE: 'inbound_message',
  CREATE_TASK: 'create_task',
};

// Build name-keyed user ID lookup from constants
const GHL_USER_IDS_BY_NAME = {};
for (const [key, id] of Object.entries(GHL_USER_IDS)) {
  // Convert UPPERCASE key to Title case (JOAN -> Joan)
  const name = key.charAt(0) + key.slice(1).toLowerCase();
  GHL_USER_IDS_BY_NAME[name] = id;
}

/**
 * Get GHL user ID for an artist by name
 */
function getGHLUserIdForArtist(artistName) {
  if (!artistName) return null;

  // Try exact match in name-keyed lookup
  if (GHL_USER_IDS_BY_NAME[artistName]) {
    return GHL_USER_IDS_BY_NAME[artistName];
  }

  // Try case-insensitive match
  const normalizedName = artistName.trim();
  for (const [name, id] of Object.entries(GHL_USER_IDS_BY_NAME)) {
    if (name.toLowerCase() === normalizedName.toLowerCase()) {
      return id;
    }
  }

  // If artistName looks like a GHL user ID already, return it
  if (artistName.length > 15 && !artistName.includes(' ')) {
    return artistName;
  }

  return null;
}

/**
 * Get contact from GHL API with custom fields
 */
async function getGHLContactWithCustomFields(contactId) {
  // Use GHL_FILE_UPLOAD_TOKEN (PIT token) for v2 API calls
  const ghlAccessToken = process.env.GHL_ACCESS_TOKEN || process.env.GHL_FILE_UPLOAD_TOKEN;

  if (!ghlAccessToken) {
    console.log('⚠️ GHL access token not configured, skipping GHL API call');
    return null;
  }

  try {
    const response = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${ghlAccessToken}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      console.error(`❌ GHL API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    return data.contact || data;
  } catch (err) {
    console.error('❌ Error fetching GHL contact:', err.message);
    return null;
  }
}

/**
 * Extract custom field value from GHL contact by field ID
 */
function getGHLCustomFieldValue(contact, fieldId) {
  if (!contact) return null;

  if (contact.customFields && Array.isArray(contact.customFields)) {
    const field = contact.customFields.find(f => f.id === fieldId);
    if (field) return field.value;
  }

  if (contact.customField && Array.isArray(contact.customField)) {
    const field = contact.customField.find(f => f.id === fieldId);
    if (field) return field.value;
  }

  return null;
}

// ============================================================================
// Main Event Dispatcher
// ============================================================================

/**
 * Handle an AI Setter event — called directly (no HTTP)
 */
async function handleAISetterEvent(payload) {
  const { type, contactId, timestamp, data } = payload;

  if (!type || !contactId) {
    console.warn('⚠️ handleAISetterEvent called without type or contactId');
    return { success: false, error: 'Missing type or contactId' };
  }

  // Store the event in Supabase
  const event = {
    event_type: type,
    contact_id: contactId,
    event_timestamp: timestamp || new Date().toISOString(),
    event_data: data || {},
    created_at: new Date().toISOString(),
  };

  try {
    const { error: insertError } = await supabase
      .from('ai_setter_events')
      .insert([event]);

    if (insertError) {
      console.error('❌ Error inserting AI Setter event:', insertError);
    } else {
      console.log('✅ AI Setter event stored in Supabase');
    }
  } catch (err) {
    console.error('❌ Error storing event:', err.message);
  }

  // Handle specific event types
  try {
    switch (type) {
      case AI_SETTER_EVENT_TYPES.DEPOSIT_PAID:
        await handleDepositPaid(contactId, data);
        break;
      case AI_SETTER_EVENT_TYPES.LEAD_QUALIFIED:
        await handleLeadQualified(contactId, data);
        break;
      case AI_SETTER_EVENT_TYPES.APPOINTMENT_BOOKED:
        await handleAppointmentBooked(contactId, data);
        break;
      case AI_SETTER_EVENT_TYPES.CONSULTATION_ENDED:
        await handleConsultationEnded(contactId, data);
        break;
      case AI_SETTER_EVENT_TYPES.PHASE_CHANGED:
        await handlePhaseChanged(contactId, data);
        break;
      case AI_SETTER_EVENT_TYPES.LEAD_ASSIGNED:
        await handleLeadAssigned(contactId, data);
        break;
      case AI_SETTER_EVENT_TYPES.HUMAN_HANDOFF:
        await handleHumanHandoff(contactId, data);
        break;
      case AI_SETTER_EVENT_TYPES.INBOUND_MESSAGE:
        await handleInboundMessage(contactId, data);
        break;
      case AI_SETTER_EVENT_TYPES.CREATE_TASK:
        await handleCreateTask(contactId, data);
        break;
      default:
        console.log(`ℹ️ Unhandled AI Setter event type: ${type}`);
    }
  } catch (err) {
    console.error(`❌ Error handling ${type} event:`, err.message);
  }

  return { success: true, eventType: type };
}

// ============================================================================
// Individual Event Handlers
// ============================================================================

async function handleDepositPaid(contactId, data) {
  console.log('💰 Processing deposit_paid event for contact:', contactId);

  const { amount, paymentId, artistId, consultationType, contactName, locationId } = data || {};

  let contact = null;
  let assignedTo = artistId ? [artistId] : [];
  let name = contactName || 'Unknown Contact';
  let locId = locationId;

  if (!contactName || !locationId || !artistId) {
    contact = await getContactInfo(contactId);
    if (contact) {
      name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unknown Contact';
      locId = locId || contact.location_id;
      if (!artistId && contact.assigned_to) {
        assignedTo = [contact.assigned_to];
      }
    }
  }

  // Create Artist Introduction task
  if (assignedTo.length > 0 && locId) {
    try {
      const exists = await taskExists(TASK_TYPES.ARTIST_INTRODUCTION, contactId, 'deposit_paid');
      if (!exists) {
        await createCommandCenterTask({
          type: TASK_TYPES.ARTIST_INTRODUCTION,
          contactId,
          contactName: name,
          assignedTo,
          triggerEvent: 'deposit_paid',
          locationId: locId,
          metadata: {
            deposit_amount: amount ? String(amount) : null,
            consultation_type: consultationType || null,
          },
        });
      } else {
        console.log('ℹ️ Artist introduction task already exists for this contact');
      }
    } catch (err) {
      console.error('❌ Error creating artist introduction task:', err.message);
    }
  }

  // Create notification record
  const notification = {
    contact_id: contactId,
    notification_type: 'deposit_paid',
    title: 'Deposit Received',
    body: `${name} has paid their $${amount ? (amount / 100).toFixed(2) : '0.00'} deposit`,
    data: { paymentId, artistId, consultationType },
    read: false,
    created_at: new Date().toISOString(),
  };

  try {
    await supabase.from('notifications').insert([notification]);
    console.log('✅ Deposit notification created');
  } catch (err) {
    console.log('ℹ️ Could not create notification (table may not exist):', err.message);
  }
}

async function handleLeadQualified(contactId, data) {
  console.log('✅ Processing lead_qualified event for contact:', contactId);
  const { assignedArtist, consultationType, tattooSummary } = data || {};
  console.log(`Lead ${contactId} qualified - assigned to ${assignedArtist}, consult type: ${consultationType}`);
}

async function handleAppointmentBooked(contactId, data) {
  console.log('📅 Processing appointment_booked event for contact:', contactId);

  const { appointmentId, appointmentTime, artistId, appointmentType, contactName, locationId } = data || {};

  let contact = null;
  let assignedTo = artistId ? [artistId] : [];
  let name = contactName || 'Unknown Contact';
  let locId = locationId;

  if (!contactName || !locationId || !artistId) {
    contact = await getContactInfo(contactId);
    if (contact) {
      name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unknown Contact';
      locId = locId || contact.location_id;
      if (!artistId && contact.assigned_to) {
        assignedTo = [contact.assigned_to];
      }
    }
  }

  if (!appointmentTime || assignedTo.length === 0 || !locId) {
    console.log('ℹ️ Cannot create task - missing required data');
    return;
  }

  const apptDate = new Date(appointmentTime);
  const apptType = (appointmentType || '').toLowerCase();

  try {
    if (apptType.includes('consultation') || apptType.includes('consult')) {
      const dueDate = new Date(apptDate.getTime() - 2 * 60 * 60 * 1000);
      if (dueDate > new Date()) {
        const exists = await taskExists(TASK_TYPES.PRE_CONSULTATION_NOTES, contactId, 'consultation_booked');
        if (!exists) {
          await createCommandCenterTask({
            type: TASK_TYPES.PRE_CONSULTATION_NOTES,
            contactId,
            contactName: name,
            assignedTo,
            triggerEvent: 'consultation_booked',
            relatedAppointmentId: appointmentId,
            locationId: locId,
            customDueDate: dueDate,
            metadata: { appointment_time: appointmentTime },
          });
        }
      }
    } else if (apptType.includes('tattoo') || apptType.includes('session')) {
      const dueDate = new Date(apptDate.getTime() - 48 * 60 * 60 * 1000);
      if (dueDate > new Date()) {
        const exists = await taskExists(TASK_TYPES.FINAL_CHECKLIST, contactId, 'tattoo_booked');
        if (!exists) {
          await createCommandCenterTask({
            type: TASK_TYPES.FINAL_CHECKLIST,
            contactId,
            contactName: name,
            assignedTo,
            triggerEvent: 'tattoo_booked',
            relatedAppointmentId: appointmentId,
            locationId: locId,
            customDueDate: dueDate,
            metadata: { appointment_time: appointmentTime },
          });
        }
      }
    }
  } catch (err) {
    console.error('❌ Error creating appointment task:', err.message);
  }
}

async function handleConsultationEnded(contactId, data) {
  console.log('🎬 Processing consultation_ended event for contact:', contactId);

  const { appointmentId, artistId, contactName, locationId, consultationType, conversationId, calendarId } = data || {};

  let contact = null;
  let assignedTo = artistId ? [artistId] : [];
  let name = contactName || 'Unknown Contact';
  let locId = locationId;
  let contactOwner = null;

  if (!contactName || !locationId || !artistId) {
    contact = await getContactInfo(contactId);
    if (contact) {
      name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unknown Contact';
      locId = locId || contact.location_id;
      contactOwner = contact.assigned_to;
      if (!artistId && contact.assigned_to) {
        assignedTo = [contact.assigned_to];
      }
    }
  }

  if (assignedTo.length === 0 || !locId) {
    console.log('ℹ️ Cannot create tasks - missing assignedTo or locationId');
    return;
  }

  // Determine Route A (admin consultation) vs Route B (artist consultation)
  const isAdminConsultation = calendarId && ADMIN_CONSULTATION_CALENDARS.includes(calendarId);
  console.log(`📋 Consultation type: ${isAdminConsultation ? 'Admin (Route A)' : 'Artist (Route B)'}, Calendar: ${calendarId || 'unknown'}`);

  try {
    if (isAdminConsultation) {
      // Route A: Create Quote Confirmation task for admin
      const confirmExists = await taskExists(TASK_TYPES.QUOTE_CONFIRMATION, contactId, 'consultation_ended');
      if (!confirmExists) {
        const adminAssignee = GHL_USER_IDS.MARIA;
        const dueAt = new Date(Date.now() + 1 * 60 * 60 * 1000);

        await createCommandCenterTask({
          type: TASK_TYPES.QUOTE_CONFIRMATION,
          contactId,
          contactName: name,
          assignedTo: [adminAssignee],
          triggerEvent: 'consultation_ended',
          relatedAppointmentId: appointmentId,
          relatedConversationId: conversationId,
          locationId: locId,
          customDueDate: dueAt,
          metadata: {
            consultation_type: consultationType || null,
            consultation_calendar: calendarId,
            assigned_artist: contactOwner || assignedTo[0],
            is_admin_consultation: 'true',
          },
        });
        console.log('✅ Created quote_confirmation task for admin (Route A)');
      }
    } else {
      // Route B: Create Quote Lead task for artist
      const quoteExists = await taskExists(TASK_TYPES.QUOTE_LEAD, contactId, 'consultation_ended');
      if (!quoteExists) {
        await createCommandCenterTask({
          type: TASK_TYPES.QUOTE_LEAD,
          contactId,
          contactName: name,
          assignedTo,
          triggerEvent: 'consultation_ended',
          relatedAppointmentId: appointmentId,
          relatedConversationId: conversationId,
          locationId: locId,
          metadata: { consultation_type: consultationType || null },
        });
        console.log('✅ Created quote_lead task for artist (Route B)');
      }
    }

    // Send Design Sketch task (both routes)
    const sketchExists = await taskExists(TASK_TYPES.SEND_DESIGN_SKETCH, contactId, 'consultation_ended');
    if (!sketchExists) {
      await createCommandCenterTask({
        type: TASK_TYPES.SEND_DESIGN_SKETCH,
        contactId,
        contactName: name,
        assignedTo,
        triggerEvent: 'consultation_ended',
        relatedAppointmentId: appointmentId,
        relatedConversationId: conversationId,
        locationId: locId,
      });
    }

    // Post-Consultation Follow-up task (both routes)
    const followupExists = await taskExists(TASK_TYPES.POST_CONSULTATION_FOLLOWUP, contactId, 'consultation_ended');
    if (!followupExists) {
      await createCommandCenterTask({
        type: TASK_TYPES.POST_CONSULTATION_FOLLOWUP,
        contactId,
        contactName: name,
        assignedTo,
        triggerEvent: 'consultation_ended',
        relatedAppointmentId: appointmentId,
        relatedConversationId: conversationId,
        locationId: locId,
      });
    }

    // Quote Verification task if quote is missing or client not informed
    const verifyExists = await taskExists(TASK_TYPES.QUOTE_VERIFICATION, contactId, 'consultation_ended');
    if (!verifyExists) {
      const ghlContact = await getGHLContactWithCustomFields(contactId);

      if (ghlContact) {
        const quotedValue = getGHLCustomFieldValue(ghlContact, GHL_CUSTOM_FIELD_IDS.QUOTED);
        const clientInformed = getGHLCustomFieldValue(ghlContact, GHL_CUSTOM_FIELD_IDS.CLIENT_INFORMED);
        const languagePreference = getGHLCustomFieldValue(ghlContact, GHL_CUSTOM_FIELD_IDS.LANGUAGE_PREFERENCE);

        const hasQuote = quotedValue && String(quotedValue).trim() !== '';
        const isClientInformed = clientInformed &&
          (String(clientInformed).toLowerCase() === 'yes' || String(clientInformed).toLowerCase() === 'true');

        const needsVerification = !hasQuote || !isClientInformed;

        console.log(`💰 Quote verification check - hasQuote: ${hasQuote}, isClientInformed: ${isClientInformed}, needsVerification: ${needsVerification}`);

        if (needsVerification) {
          const verificationAssignees = [];
          const owner = ghlContact.assignedTo || contactOwner || assignedTo[0];
          if (owner) verificationAssignees.push(owner);

          if (ghlContact.followers && Array.isArray(ghlContact.followers)) {
            for (const follower of ghlContact.followers) {
              if (follower && !verificationAssignees.includes(follower)) {
                verificationAssignees.push(follower);
              }
            }
          }

          if (verificationAssignees.length > 0) {
            await createCommandCenterTask({
              type: TASK_TYPES.QUOTE_VERIFICATION,
              contactId,
              contactName: name,
              assignedTo: verificationAssignees,
              triggerEvent: 'consultation_ended',
              relatedAppointmentId: appointmentId,
              relatedConversationId: conversationId,
              locationId: locId,
              metadata: {
                current_quote: hasQuote ? String(quotedValue) : '',
                client_informed: isClientInformed ? 'true' : 'false',
                requires_quote_entry: hasQuote ? 'false' : 'true',
                language_preference: languagePreference || 'english',
              },
            });
            console.log(`✅ Created quote_verification task for ${verificationAssignees.length} assignee(s)`);
          }
        } else {
          console.log('✅ Quote verification not needed - quote is filled and client was informed');
        }
      }
    }
  } catch (err) {
    console.error('❌ Error creating consultation tasks:', err.message);
  }

  console.log(`[ConsultationEnded] Artifact fetching handled by Pub/Sub push notifications`);
}

async function handleInboundMessage(contactId, data) {
  console.log('📩 Processing inbound_message event for contact:', contactId);

  const { messageId, conversationId, depositPaid, contactName, locationId, assignedTo: assignedArtist } = data || {};

  if (!depositPaid) {
    console.log('ℹ️ Skipping reply task - deposit not paid yet');
    return;
  }

  let contact = null;
  let assignedTo = assignedArtist ? [assignedArtist] : [];
  let name = contactName || 'Unknown Contact';
  let locId = locationId;

  if (!contactName || !locationId || !assignedArtist) {
    contact = await getContactInfo(contactId);
    if (contact) {
      name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unknown Contact';
      locId = locId || contact.location_id;
      if (!assignedArtist && contact.assigned_to) {
        assignedTo = [contact.assigned_to];
      }
    }
  }

  if (assignedTo.length === 0 || !locId) return;

  try {
    const exists = await taskExists(TASK_TYPES.REPLY_TO_CLIENT, contactId, 'inbound_message');
    if (!exists) {
      await createCommandCenterTask({
        type: TASK_TYPES.REPLY_TO_CLIENT,
        contactId,
        contactName: name,
        assignedTo,
        triggerEvent: 'inbound_message',
        relatedConversationId: conversationId,
        targetMessageId: messageId,
        locationId: locId,
      });
    }
  } catch (err) {
    console.error('❌ Error creating reply task:', err.message);
  }
}

async function handleCreateTask(contactId, data) {
  console.log('📋 Processing create_task event for contact:', contactId);

  const { taskType, contactName, assignedArtist, consultationType, metadata = {} } = data || {};

  if (!taskType) {
    console.log('⚠️ No taskType provided in create_task event');
    return;
  }

  let mappedTaskType;
  switch (taskType) {
    case 'artist_introduction':
      mappedTaskType = TASK_TYPES.ARTIST_INTRODUCTION;
      break;
    case 'pre_consultation_notes':
      mappedTaskType = TASK_TYPES.PRE_CONSULTATION_NOTES;
      break;
    default:
      console.log(`⚠️ Unknown task type: ${taskType}`);
      return;
  }

  const artistUserId = getGHLUserIdForArtist(assignedArtist);
  let assignedTo = artistUserId ? [artistUserId] : [];
  const name = contactName || 'Unknown Contact';
  const locationId = process.env.GHL_LOCATION_ID || 'mUemx2jG4wly4kJWBkI4';

  if (assignedTo.length === 0) {
    const contact = await getContactInfo(contactId);
    if (contact?.assigned_to) {
      assignedTo.push(contact.assigned_to);
    }
  }

  if (assignedTo.length === 0) {
    console.log('⚠️ Cannot create task - no artist assigned');
    return;
  }

  try {
    const exists = await taskExists(mappedTaskType, contactId, 'deposit_paid');
    if (exists) {
      console.log(`ℹ️ Task ${taskType} already exists for ${name}`);
      return;
    }

    await createCommandCenterTask({
      type: mappedTaskType,
      contactId,
      contactName: name,
      assignedTo,
      triggerEvent: 'deposit_paid',
      locationId,
      metadata: {
        consultation_type: consultationType || null,
        tattoo_size: metadata.tattoo_size || null,
        reason: metadata.reason || null,
        route: metadata.route || null,
        ...metadata
      },
    });

    console.log(`✅ Created ${taskType} task for ${name}`);
  } catch (err) {
    console.error(`❌ Error creating ${taskType} task:`, err.message);
  }
}

async function handlePhaseChanged(contactId, data) {
  console.log('🔄 Processing phase_changed event for contact:', contactId);
  const { previousPhase, newPhase, leadTemperature } = data || {};
  console.log(`Lead ${contactId} moved from ${previousPhase} to ${newPhase} (temp: ${leadTemperature})`);
}

async function handleLeadAssigned(contactId, data) {
  console.log('👤 Processing lead_assigned event for contact:', contactId);
  const { artistId, artistName } = data || {};
  console.log(`Lead ${contactId} assigned to ${artistName} (${artistId})`);
}

async function handleHumanHandoff(contactId, data) {
  console.log('🤝 Processing human_handoff event for contact:', contactId);

  const { reason, assignedTo, lastAIMessage } = data || {};

  const notification = {
    contact_id: contactId,
    notification_type: 'human_handoff',
    title: 'Human Attention Needed',
    body: reason || 'AI Setter has requested human assistance',
    data: { assignedTo, lastAIMessage },
    read: false,
    priority: 'high',
    created_at: new Date().toISOString(),
  };

  try {
    await supabase.from('notifications').insert([notification]);
    console.log('✅ Human handoff notification created');
  } catch (err) {
    console.log('ℹ️ Could not create notification:', err.message);
  }
}

module.exports = {
  handleAISetterEvent,
  AI_SETTER_EVENT_TYPES,
  ADMIN_CONSULTATION_CALENDARS,
};
