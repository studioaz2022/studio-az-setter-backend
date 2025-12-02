// bookingController.js
// Handles appointment booking orchestration

const { getContact } = require("../../ghlClient");
const { determineArtist, getCalendarIdForArtist, artistWorkloads } = require("./artistRouter");
const {
  createAppointment,
  listAppointmentsForContact,
  getConsultAppointmentsForContact,
} = require("../clients/ghlCalendarClient");
const { CALENDARS, HOLD_CONFIG, APPOINTMENT_STATUS } = require("../config/constants");
const { sendConversationMessage } = require("../../ghlClient");

/**
 * Generate suggested time slots for a consult
 * For now, generates a simple set of options based on common availability
 * TODO: In the future, this could call a slots API or calendar availability endpoint
 */
function generateSuggestedSlots(preferredTimeWindow = null) {
  const now = new Date();
  const slots = [];

  // Get next few weekdays
  let currentDate = new Date(now);
  currentDate.setHours(0, 0, 0, 0);

  // Skip to next weekday if today is weekend
  while (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Generate 3 options
  for (let i = 0; i < 3; i++) {
    // Find next weekday
    while (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Default to evening (5pm) for weekdays, morning (10am) for weekends
    const hour = preferredTimeWindow?.includes("morning") ? 10 : 17;
    const slotDate = new Date(currentDate);
    slotDate.setHours(hour, 0, 0, 0);

    // Make sure it's in the future
    if (slotDate > now) {
      const endTime = new Date(slotDate);
      endTime.setMinutes(endTime.getMinutes() + 30); // 30-minute consult

      slots.push({
        startTime: slotDate.toISOString(),
        endTime: endTime.toISOString(),
        displayText: formatSlotDisplay(slotDate),
      });
    }

    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return slots.slice(0, 3); // Return up to 3 options
}

/**
 * Format a date/time for display
 */
function formatSlotDisplay(date) {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = days[date.getDay()];
  const month = date.toLocaleString("default", { month: "short" });
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const ampm = hour >= 12 ? "pm" : "am";
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const displayMinute = minute === 0 ? "" : `:${minute.toString().padStart(2, "0")}`;

  return `${dayName}, ${month} ${day} at ${displayHour}${displayMinute}${ampm}`;
}

/**
 * Parse user's time selection from their message
 * Returns the selected slot index (0-based) or null if not found
 */
function parseTimeSelection(messageText, availableSlots) {
  if (!messageText || !availableSlots || availableSlots.length === 0) {
    return null;
  }

  const text = String(messageText).toLowerCase().trim();

  // Check for explicit option numbers
  for (let i = 0; i < availableSlots.length; i++) {
    if (
      text.includes(`option ${i + 1}`) ||
      text.includes(`#${i + 1}`) ||
      text.includes(`${i + 1}`) ||
      text === `${i + 1}`
    ) {
      return i;
    }
  }

  // Check for day names
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 0; i < availableSlots.length; i++) {
    const slotDate = new Date(availableSlots[i].startTime);
    const dayName = days[slotDate.getDay()];
    if (text.includes(dayName)) {
      return i;
    }
  }

  // Check for time mentions (e.g. "5pm", "5:00", "evening")
  for (let i = 0; i < availableSlots.length; i++) {
    const slotDate = new Date(availableSlots[i].startTime);
    const hour = slotDate.getHours();
    const hour12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    const ampm = hour >= 12 ? "pm" : "am";

    if (
      text.includes(`${hour12}${ampm}`) ||
      text.includes(`${hour12}:00${ampm}`) ||
      (hour >= 17 && text.includes("evening")) ||
      (hour < 12 && text.includes("morning"))
    ) {
      return i;
    }
  }

  return null;
}

/**
 * Select artist based on availability/workload when no preference is given
 * Returns artist name or null
 * 
 * Logic:
 * 1. If both artists have the same availability for the timeframe, select by workload (least busy)
 * 2. Otherwise, select the artist with better availability
 * 3. For now, we use workload comparison as a simple heuristic
 */
function selectArtistByAvailability(consultMode = "online") {
  // Compare workloads - select artist with lower workload
  const joanWorkload = artistWorkloads["Joan"] || 0;
  const andrewWorkload = artistWorkloads["Andrew"] || 0;
  
  // TODO: Enhance this to check actual calendar availability for the requested timeframe
  // For now, use workload as a simple balancing mechanism
  if (joanWorkload <= andrewWorkload) {
    return "Joan";
  } else {
    return "Andrew";
  }
}

/**
 * Handle appointment booking when AI wants to offer times
 */
async function handleAppointmentOffer({ contact, aiMeta, contactProfile }) {
  try {
    // Determine artist - if not found, select by availability/workload
    let artist = determineArtist(contact);
    
    if (!artist) {
      console.log("ℹ️ No artist preference found, selecting by availability/workload");
      const consultMode = aiMeta?.consultMode || "online";
      artist = selectArtistByAvailability(consultMode);
      console.log(`✅ Selected artist ${artist} based on availability/workload`);
    }

    if (!artist) {
      console.warn("⚠️ Could not determine or select artist for appointment offer");
      return null;
    }

    // Determine consult mode (default to online)
    const consultMode = aiMeta?.consultMode || "online";
    const preferredTimeWindow = aiMeta?.preferredTimeWindow || null;

    // Get calendar ID
    const calendarId = getCalendarIdForArtist(artist, consultMode);
    if (!calendarId) {
      console.warn(`⚠️ Could not find calendar for artist ${artist}, mode ${consultMode}`);
      return null;
    }

    // Generate suggested slots
    const slots = generateSuggestedSlots(preferredTimeWindow);
    if (slots.length === 0) {
      console.warn("⚠️ Could not generate time slots");
      return null;
    }

    console.log(`📅 Generated ${slots.length} time slots for ${artist} (${consultMode}):`, slots);

    // Return slots for AI to present or backend to send
    return {
      artist,
      consultMode,
      calendarId,
      slots,
    };
  } catch (err) {
    console.error("❌ Error handling appointment offer:", err.message || err);
    return null;
  }
}

/**
 * Create appointment when user selects a time
 */
async function createConsultAppointment({
  contactId,
  calendarId,
  startTime,
  endTime,
  artist,
  consultMode,
  contactProfile,
}) {
  try {
    const contact = await getContact(contactId);
    if (!contact) {
      throw new Error(`Contact ${contactId} not found`);
    }

    // Build appointment title
    const tattooSummary = contactProfile?.tattooSummary || "tattoo";
    const title = `Consultation - ${artist} (${consultMode === "online" ? "Online" : "In-Person"})`;

    // Build description
    const description = `Consultation for ${tattooSummary}`;

    // Create appointment with status "new" (on hold)
    const appointment = await createAppointment({
      calendarId,
      contactId,
      startTime,
      endTime,
      title,
      description,
      appointmentStatus: APPOINTMENT_STATUS.NEW,
      address: consultMode === "online" ? "Zoom" : null,
      meetingLocationType: consultMode === "online" ? "custom" : null,
    });

    console.log(`✅ Created tentative appointment:`, {
      appointmentId: appointment.id,
      calendarId,
      contactId,
      startTime,
      appointmentStatus: APPOINTMENT_STATUS.NEW,
    });

    // Send confirmation message explaining the hold
    const slotDisplay = formatSlotDisplay(new Date(startTime));
    const holdMessage = `Perfect! I've got you tentatively set for ${slotDisplay}. I'll hold this spot for about ${HOLD_CONFIG.HOLD_MINUTES} minutes while you place the $100 refundable deposit. If we don't receive it in that window, we may have to release the time for other clients - but I'll send you a quick reminder before we do.`;

    // Determine channel context (reuse logic from message webhook)
    const hasPhone = !!(contact.phone || contact.phoneNumber);
    const tags = contact.tags || [];
    const isDm = tags.some(
      (t) =>
        typeof t === "string" &&
        (t.includes("INSTAGRAM") || t.includes("FACEBOOK") || t.includes("DM"))
    );

    const channelContext = {
      isDm,
      hasPhone,
      conversationId: null,
      phone: contact.phone || contact.phoneNumber || null,
    };

    await sendConversationMessage({
      contactId,
      body: holdMessage,
      channelContext,
    });

    return appointment;
  } catch (err) {
    console.error("❌ Error creating consult appointment:", err.message || err);
    throw err;
  }
}

/**
 * Check if user's message indicates they're selecting a time slot
 * This is a heuristic check - looks for patterns like "option 1", day names, times, etc.
 */
function isTimeSelection(messageText, availableSlots = []) {
  if (!messageText) return false;
  
  const text = String(messageText).toLowerCase().trim();
  
  // If we have slots, use parseTimeSelection
  if (availableSlots.length > 0) {
    return parseTimeSelection(messageText, availableSlots) !== null;
  }
  
  // Otherwise, use heuristics to detect if it might be a time selection
  const timePatterns = [
    /option\s*[123]/, // "option 1", "option 2", etc.
    /^[123]$/, // Just "1", "2", "3"
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\b\d+\s*(am|pm|:00)\b/i, // Times like "5pm", "10:00"
    /\b(morning|afternoon|evening|night)\b/i,
    /\b(this|next)\s*(week|monday|tuesday|etc)\b/i,
  ];
  
  return timePatterns.some((pattern) => pattern.test(text));
}

module.exports = {
  handleAppointmentOffer,
  createConsultAppointment,
  parseTimeSelection,
  isTimeSelection,
  generateSuggestedSlots,
  formatSlotDisplay,
  selectArtistByAvailability,
};

