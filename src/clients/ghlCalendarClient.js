// ghlCalendarClient.js
// GHL Calendar API client for appointment booking

require("dotenv").config();
const axios = require("axios");

const GHL_FILE_UPLOAD_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE_URL = "https://services.leadconnectorhq.com";

if (!GHL_FILE_UPLOAD_TOKEN) {
  console.warn("[GHL Calendar] GHL_FILE_UPLOAD_TOKEN is not set.");
}

if (!GHL_LOCATION_ID) {
  console.warn("[GHL Calendar] GHL_LOCATION_ID is not set.");
}

function ghlHeaders() {
  return {
    Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    Version: "2021-04-15",
  };
}

/**
 * Create an appointment on a GHL calendar
 * @param {Object} params
 * @param {string} params.calendarId - Calendar ID
 * @param {string} params.contactId - Contact ID
 * @param {string} params.locationId - Location ID (defaults to GHL_LOCATION_ID)
 * @param {string} params.startTime - ISO datetime string
 * @param {string} params.endTime - ISO datetime string
 * @param {string} params.title - Appointment title
 * @param {string} [params.description] - Appointment description/notes
 * @param {string} [params.appointmentStatus] - Status: "new", "confirmed", "cancelled", etc.
 * @param {string} [params.assignedUserId] - User ID to assign (optional)
 * @param {string} [params.address] - Meeting address (e.g. "Zoom" for online)
 * @param {string} [params.meetingLocationType] - "custom" for online, etc.
 * @param {string} [params.meetingLocationId] - Location ID for meeting
 * @param {boolean} [params.ignoreDateRange] - Whether to ignore date range validation
 * @param {boolean} [params.ignoreFreeSlotValidation] - Whether to ignore free slot validation
 * @returns {Promise<Object>} Created appointment object
 */
async function createAppointment({
  calendarId,
  contactId,
  locationId = GHL_LOCATION_ID,
  startTime,
  endTime,
  title,
  description = "",
  appointmentStatus = "new",
  assignedUserId = null,
  address = "Zoom",
  meetingLocationType = "custom",
  meetingLocationId = "custom_0",
  ignoreDateRange = false,
  ignoreFreeSlotValidation = true,
}) {
  if (!calendarId) {
    throw new Error("calendarId is required for createAppointment");
  }
  if (!contactId) {
    throw new Error("contactId is required for createAppointment");
  }
  if (!startTime || !endTime) {
    throw new Error("startTime and endTime are required for createAppointment");
  }
  if (!locationId) {
    throw new Error("locationId is required (set GHL_LOCATION_ID env var)");
  }

  const url = `${GHL_BASE_URL}/calendars/events/appointments`;

  const payload = {
    title: title || "Consultation",
    meetingLocationType,
    meetingLocationId,
    overrideLocationConfig: true,
    appointmentStatus,
    description,
    address,
    ignoreDateRange,
    toNotify: false,
    ignoreFreeSlotValidation,
    calendarId,
    locationId,
    contactId,
    startTime,
    endTime,
  };

  // Add optional fields if provided
  if (assignedUserId) {
    payload.assignedUserId = assignedUserId;
  }

  try {
    const resp = await axios.post(url, payload, {
      headers: ghlHeaders(),
    });

    console.log("✅ Created appointment:", {
      appointmentId: resp.data?.id,
      calendarId,
      contactId,
      startTime,
      appointmentStatus,
    });

    return resp.data;
  } catch (err) {
    console.error("❌ Error creating appointment:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * List appointments for a contact
 * @param {string} contactId - Contact ID
 * @returns {Promise<Array>} Array of appointment objects
 */
async function listAppointmentsForContact(contactId) {
  if (!contactId) {
    throw new Error("contactId is required for listAppointmentsForContact");
  }

  const url = `${GHL_BASE_URL}/contacts/${encodeURIComponent(contactId)}/appointments`;

  try {
    const resp = await axios.get(url, {
      headers: ghlHeaders(),
    });

    const events = resp.data?.events || [];
    console.log(`✅ Found ${events.length} appointments for contact ${contactId}`);

    return events;
  } catch (err) {
    console.error(
      "❌ Error listing appointments for contact:",
      err.response?.data || err.message
    );
    throw err;
  }
}

/**
 * Update appointment status
 * @param {string} appointmentId - Appointment ID
 * @param {string} status - New status: "new", "confirmed", "cancelled", etc.
 * @returns {Promise<Object>} Updated appointment object
 */
async function updateAppointmentStatus(appointmentId, status, calendarId = null) {
  if (!appointmentId) {
    throw new Error("appointmentId is required for updateAppointmentStatus");
  }
  if (!status) {
    throw new Error("status is required for updateAppointmentStatus");
  }

  const url = `${GHL_BASE_URL}/calendars/events/appointments/${encodeURIComponent(
    appointmentId
  )}`;

  const payload = {
    appointmentStatus: status,
    toNotify: false,
  };

  // Include calendarId if provided (required by some GHL clusters)
  if (calendarId) {
    payload.calendarId = calendarId;
  }

  try {
    // GHL uses PUT for appointment updates, not PATCH
    const resp = await axios.put(url, payload, {
      headers: ghlHeaders(),
    });

    console.log("✅ Updated appointment status:", {
      appointmentId,
      status,
    });

    return resp.data;
  } catch (err) {
    console.error("❌ Error updating appointment status:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Reschedule an appointment (update start/end and optional status)
 * Note: GHL uses PUT (not PATCH) for updating appointments
 */
async function rescheduleAppointment(appointmentId, { startTime, endTime, appointmentStatus = null, calendarId = null, assignedUserId = null }) {
  if (!appointmentId) {
    throw new Error("appointmentId is required for rescheduleAppointment");
  }
  if (!startTime || !endTime) {
    throw new Error("startTime and endTime are required for rescheduleAppointment");
  }

  const url = `${GHL_BASE_URL}/calendars/events/appointments/${encodeURIComponent(
    appointmentId
  )}`;

  const payload = {
    startTime,
    endTime,
    ignoreFreeSlotValidation: true,
    overrideLocationConfig: true,
    toNotify: false,
  };

  // Include calendarId if provided (required by some GHL clusters)
  if (calendarId) {
    payload.calendarId = calendarId;
  }

  // Include assignedUserId if provided (required by translator calendars)
  if (assignedUserId) {
    payload.assignedUserId = assignedUserId;
  }

  if (appointmentStatus) {
    payload.appointmentStatus = appointmentStatus;
  }

  try {
    // GHL uses PUT for appointment updates, not PATCH
    const resp = await axios.put(url, payload, {
      headers: ghlHeaders(),
    });
    console.log("✅ Rescheduled appointment:", {
      appointmentId,
      startTime,
      endTime,
      appointmentStatus,
    });
    return resp.data;
  } catch (err) {
    console.error("❌ Error rescheduling appointment:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Get consult appointments for a contact (filters for future appointments on consult calendars)
 * @param {string} contactId - Contact ID
 * @param {Array<string>} consultCalendarIds - Array of calendar IDs to filter by
 * @returns {Promise<Array>} Filtered appointment objects
 */
async function getConsultAppointmentsForContact(contactId, consultCalendarIds) {
  const allAppointments = await listAppointmentsForContact(contactId);
  const now = new Date();

  return allAppointments.filter((apt) => {
    // Must be on one of our consult calendars
    if (!consultCalendarIds.includes(apt.calendarId)) {
      return false;
    }

    // Must be in the future
    const startTime = new Date(apt.startTime);
    if (startTime <= now) {
      return false;
    }

    // Must be "new" or "confirmed" (not cancelled)
    if (apt.appointmentStatus === "cancelled") {
      return false;
    }

    return true;
  });
}

/**
 * Get free/available slots from a GHL calendar
 * @param {string} calendarId - Calendar ID to query
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range (max 31 days from startDate)
 * @returns {Promise<Array>} Array of slot objects with startTime, endTime, displayText
 * 
 * NOTE: GHL API constraint - date range cannot exceed 31 days
 */
async function getCalendarFreeSlots(calendarId, startDate, endDate) {
  if (!calendarId) {
    throw new Error("calendarId is required for getCalendarFreeSlots");
  }
  if (!startDate || !endDate) {
    throw new Error("startDate and endDate are required for getCalendarFreeSlots");
  }

  // Convert to milliseconds timestamp for GHL API
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  // GHL API constraint: date range cannot exceed 31 days
  const maxRangeMs = 31 * 24 * 60 * 60 * 1000; // 31 days in milliseconds
  let finalEndMs = endMs;
  if (endMs - startMs > maxRangeMs) {
    console.warn(`⚠️ [GHL CALENDAR] Date range exceeds 31 days, capping to 31 days from start`);
    finalEndMs = startMs + maxRangeMs;
  }

  const url = `${GHL_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/free-slots?startDate=${startMs}&endDate=${finalEndMs}`;

  try {
    const resp = await axios.get(url, {
      headers: ghlHeaders(),
    });

    const data = resp.data || {};
    const slots = [];

    // Parse the response - it's organized by date with slots array
    // Example: { "2025-12-22": { "slots": ["2025-12-22T10:00:00-06:00", ...] }, ... }
    for (const [dateKey, dateData] of Object.entries(data)) {
      if (dateKey === "traceId") continue; // Skip the traceId field
      
      const dateSlots = dateData?.slots || [];
      for (const slotTime of dateSlots) {
        const startTime = new Date(slotTime);
        const endTime = new Date(startTime);
        endTime.setMinutes(endTime.getMinutes() + 30); // Assume 30-min slots

        slots.push({
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          calendarId,
        });
      }
    }

    // Sort by start time
    slots.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    console.log(`✅ [GHL CALENDAR] Found ${slots.length} free slots for calendar ${calendarId} between ${startDate.toISOString()} and ${endDate.toISOString()}`);

    return slots;
  } catch (err) {
    console.error("❌ Error fetching calendar free slots:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  createAppointment,
  listAppointmentsForContact,
  updateAppointmentStatus,
  getConsultAppointmentsForContact,
  rescheduleAppointment,
  getCalendarFreeSlots,
};

