/**
 * GHL Reschedule Webhook (barbershop)
 *
 * Pushes a "this appointment was genuinely rescheduled" event to a GHL Inbound
 * Webhook trigger so a LeadConnector-side workflow can notify the barber.
 *
 * Why this exists: the GHL-native way to detect a reschedule was to compare the
 * contact's "Appt 1: Reschedule Link" custom field against the incoming
 * appointment. That field is overwritten with the current appointment's own link
 * on the same appointment trigger, so the comparison ends up matching the
 * appointment against itself and every NEW booking is misread as a reschedule.
 *
 * The backend does not have that problem: handleAppointmentUpdated compares the
 * incoming start_time against the previously persisted start_time in Supabase,
 * keyed by appointment id. That prior state is real history, not a field the
 * booking flow rewrites.
 *
 * This module is a no-op until GHL_RESCHEDULE_WEBHOOK_URL is set, so it is safe
 * to deploy before the GHL workflow exists.
 */

const { ghlBarber, getCachedUsers } = require('./ghlMultiLocationSdk');
const { BARBER_LOCATION_ID } = require('../config/kioskConfig');

const WEBHOOK_URL = process.env.GHL_RESCHEDULE_WEBHOOK_URL;
const BOOKING_HOST = 'https://mn.studioaz.us';
const SHOP_TIMEZONE = 'America/Chicago';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 2;

/** Central-time parts for an appointment timestamp. */
function formatShopTime(value) {
  if (!value) return { iso: '', date: '', time: '', formatted: '' };

  const d = new Date(value);
  if (isNaN(d.getTime())) return { iso: '', date: '', time: '', formatted: '' };

  const date = d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: SHOP_TIMEZONE,
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: SHOP_TIMEZONE,
  });

  // Compact form for the combined field: "Mon, Aug 10 2026 2:00 PM".
  // Assembled from parts because en-US renders "Mon, Aug 10, 2026" — the comma
  // before the year isn't wanted here.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: SHOP_TIMEZONE,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  const shortDate = `${parts.weekday}, ${parts.month} ${parts.day} ${parts.year}`;

  // `date` stays long-form so previous_start_date / new_start_date keep working
  // for anything already mapped against them.
  return { iso: d.toISOString(), date, time, formatted: `${shortDate} ${time}` };
}

async function resolveContact(contactId) {
  const empty = { firstName: '', lastName: '', fullName: '', phone: '', email: '' };
  if (!contactId || !ghlBarber) return empty;

  try {
    const resp = await ghlBarber.contacts.getContact({ contactId });
    const contact = resp?.contact || resp || {};
    const firstName = (contact.firstName || '').trim();
    const lastName = (contact.lastName || '').trim();
    return {
      firstName,
      lastName,
      fullName: (contact.contactName || `${firstName} ${lastName}`).trim(),
      phone: contact.phone || '',
      email: contact.email || '',
    };
  } catch (err) {
    console.warn('⚠️ [RESCHED HOOK] Could not fetch contact:', err.message);
    return empty;
  }
}

async function resolveBarber(assignedUserId) {
  const empty = { firstName: '', name: '', email: '', phone: '' };
  if (!assignedUserId || !ghlBarber) return empty;

  try {
    const users = await getCachedUsers('barber', ghlBarber, BARBER_LOCATION_ID);
    const user = users.find((u) => u.id === assignedUserId);
    if (!user) return empty;

    return {
      firstName: (user.firstName || user.name?.split(' ')[0] || '').trim(),
      name: (user.name || `${user.firstName || ''} ${user.lastName || ''}`).trim(),
      email: user.email || '',
      phone: user.phone || '',
    };
  } catch (err) {
    console.warn('⚠️ [RESCHED HOOK] Could not look up barber:', err.message);
    return empty;
  }
}

async function postWebhook(payload) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) return true;

      lastError = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < MAX_ATTEMPTS) {
      console.warn(`⚠️ [RESCHED HOOK] Attempt ${attempt} failed (${lastError.message}) — retrying`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.error('❌ [RESCHED HOOK] Delivery failed:', lastError?.message || lastError);
  return false;
}

/**
 * Fire the reschedule webhook for a barbershop appointment.
 *
 * Safe to call unconditionally — it gates on location and on the URL being set,
 * and never throws. Duplicate GHL deliveries do not double-fire: the caller only
 * sets isRescheduled when the incoming start_time differs from the stored row,
 * and the row is upserted before this runs.
 *
 * @param {object} appointment  Raw GHL appointment from the webhook payload
 * @param {object} options
 * @param {string} options.previousStartTime  Start time before the reschedule
 * @param {number} options.rescheduleCount    Running count after this reschedule
 */
async function sendRescheduleWebhookToGHL(appointment, options = {}) {
  const locationId = appointment?.locationId;

  if (locationId !== BARBER_LOCATION_ID) return;

  if (!WEBHOOK_URL) {
    console.log('📡 [RESCHED HOOK] Skipping — GHL_RESCHEDULE_WEBHOOK_URL not set');
    return;
  }

  const appointmentId = appointment.id || appointment.appointmentId;
  const contactId = appointment.contactId;
  const calendarId = appointment.calendarId || '';

  if (!appointmentId || !contactId) {
    console.warn('⚠️ [RESCHED HOOK] Missing appointmentId or contactId — skipping');
    return;
  }

  const [contact, barber] = await Promise.all([
    resolveContact(contactId),
    resolveBarber(appointment.assignedUserId),
  ]);

  const previous = formatShopTime(options.previousStartTime);
  const next = formatShopTime(appointment.startTime);

  // Flat payload: GHL's inbound-webhook field mapping handles flat JSON far
  // better than nested objects.
  const payload = {
    event: 'appointment.rescheduled',
    appointment_id: appointmentId,
    location_id: locationId,
    calendar_id: calendarId,

    contact_id: contactId,
    contact_first_name: contact.firstName,
    contact_last_name: contact.lastName,
    contact_full_name: contact.fullName,
    contact_phone: contact.phone,
    contact_email: contact.email,

    barber_user_id: appointment.assignedUserId || '',
    barber_name: barber.name,
    barber_first_name: barber.firstName,
    barber_email: barber.email,
    barber_phone: barber.phone,

    previous_start_iso: previous.iso,
    previous_start_date: previous.date,
    previous_start_time: previous.time,
    previous_start_formatted: previous.formatted,

    new_start_iso: next.iso,
    new_start_date: next.date,
    new_start_time: next.time,
    new_start_formatted: next.formatted,

    service_title: appointment.title || '',
    appointment_status: appointment.appointmentStatus || appointment.status || '',
    reschedule_count: options.rescheduleCount || 1,

    reschedule_link: calendarId
      ? `${BOOKING_HOST}/widget/booking/${calendarId}?event_id=${appointmentId}`
      : '',
    cancellation_link: `${BOOKING_HOST}/widget/cancel-booking?event_id=${appointmentId}`,
  };

  const delivered = await postWebhook(payload);

  if (delivered) {
    console.log(
      `✅ [RESCHED HOOK] Sent for ${contact.fullName || contactId} — ` +
        `${previous.formatted || '?'} → ${next.formatted || '?'} (${barber.name || 'unassigned'})`
    );
  }
}

module.exports = { sendRescheduleWebhookToGHL };
