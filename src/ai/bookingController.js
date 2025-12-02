// bookingController.js
// Handles appointment booking orchestration

const { getContact } = require("../../ghlClient");
const {
  determineArtist,
  getCalendarIdForArtist,
  artistWorkloads,
  getAssignedUserIdForArtist,
} = require("./artistRouter");
const {
  createAppointment,
  listAppointmentsForContact,
  getConsultAppointmentsForContact,
} = require("../clients/ghlCalendarClient");
const { CALENDARS, HOLD_CONFIG, APPOINTMENT_STATUS } = require("../config/constants");
const { sendConversationMessage } = require("../../ghlClient");

// Weekday name to index mapping
const WEEKDAY_MAP = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * Generate suggested time slots for a consult
 * Supports preferredDay (e.g., "wednesday") and preferredTimeWindow (e.g., "morning")
 * 
 * @param {Object} options
 * @param {string} options.preferredTimeWindow - "morning", "afternoon", "evening"
 * @param {string} options.preferredDay - Weekday name like "wednesday" or "friday"
 */
function generateSuggestedSlots(options = {}) {
  const { preferredTimeWindow = null, preferredDay = null } = options;
  
  const now = new Date();
  const slots = [];

  // Get next few weekdays
  let currentDate = new Date(now);
  currentDate.setHours(0, 0, 0, 0);

  // If user requested a specific weekday, start from the next occurrence of that day
  if (preferredDay) {
    const targetDayIndex = WEEKDAY_MAP[preferredDay.toLowerCase()];
    if (targetDayIndex !== undefined) {
      // Find next occurrence of the requested weekday
      const currentDayIndex = currentDate.getDay();
      let daysUntilTarget = targetDayIndex - currentDayIndex;
      if (daysUntilTarget <= 0) {
        daysUntilTarget += 7; // Move to next week if today or past
      }
      currentDate.setDate(currentDate.getDate() + daysUntilTarget);
      
      console.log(`📅 User requested ${preferredDay}, starting from ${currentDate.toDateString()}`);
    }
  } else {
    // Default: Skip to next weekday if today is weekend
    while (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
      currentDate.setDate(currentDate.getDate() + 1);
    }
  }

  // Determine hour based on time preference
  let hour = 17; // Default: 5pm (evening)
  if (preferredTimeWindow) {
    const tw = preferredTimeWindow.toLowerCase();
    if (tw.includes("morning")) {
      hour = 10; // 10am
    } else if (tw.includes("afternoon")) {
      hour = 14; // 2pm
    } else if (tw.includes("evening") || tw.includes("night")) {
      hour = 17; // 5pm
    }
  }

  // Generate 3 options
  for (let i = 0; i < 3; i++) {
    // If not a specific day request, skip weekends
    if (!preferredDay) {
      while (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
        currentDate.setDate(currentDate.getDate() + 1);
      }
    }

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

    // Move to next day (or next week if specific day requested)
    if (preferredDay) {
      currentDate.setDate(currentDate.getDate() + 7); // Same day next week
    } else {
      currentDate.setDate(currentDate.getDate() + 1);
    }
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
 * 
 * Handles patterns like:
 * - "option 1", "#2", "3"
 * - "let's do Wednesday", "let's do Dec 3"
 * - "Tuesday works", "I'll take the first one"
 * - "5pm", "the evening one"
 */
function parseTimeSelection(messageText, availableSlots) {
  if (!messageText || !availableSlots || availableSlots.length === 0) {
    return null;
  }

  const text = String(messageText).toLowerCase().trim();

  // Check for explicit option numbers first
  const optionMatch = text.match(/option\s*#?(\d)/i) || text.match(/^#?(\d)$/);
  if (optionMatch) {
    const num = parseInt(optionMatch[1], 10);
    if (num >= 1 && num <= availableSlots.length) {
      return num - 1;
    }
  }

  // Check for ordinal references ("first", "second", "third")
  const ordinals = ["first", "second", "third", "1st", "2nd", "3rd"];
  for (let i = 0; i < ordinals.length && i < availableSlots.length; i++) {
    if (text.includes(ordinals[i]) || text.includes(ordinals[i + 3])) {
      return i % 3; // Map ordinals to 0, 1, 2
    }
  }

  // Check for day names (full and abbreviated)
  const daysFull = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const daysAbbr = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  
  for (let i = 0; i < availableSlots.length; i++) {
    const slotDate = new Date(availableSlots[i].startTime);
    const dayIndex = slotDate.getDay();
    const dayNameFull = daysFull[dayIndex];
    const dayNameAbbr = daysAbbr[dayIndex];
    
    // Match full day name or abbreviation
    if (text.includes(dayNameFull) || new RegExp(`\\b${dayNameAbbr}\\b`).test(text)) {
      return i;
    }
  }

  // Check for month + day mentions (e.g., "Dec 3", "December 3rd")
  const monthsFull = ["january", "february", "march", "april", "may", "june", 
                      "july", "august", "september", "october", "november", "december"];
  const monthsAbbr = ["jan", "feb", "mar", "apr", "may", "jun", 
                      "jul", "aug", "sep", "oct", "nov", "dec"];
  
  for (let i = 0; i < availableSlots.length; i++) {
    const slotDate = new Date(availableSlots[i].startTime);
    const monthIndex = slotDate.getMonth();
    const day = slotDate.getDate();
    
    const monthFull = monthsFull[monthIndex];
    const monthAbbr = monthsAbbr[monthIndex];
    
    // Check for patterns like "dec 3", "december 3", "dec 3rd"
    const dayPatterns = [
      `${monthAbbr}\\s*${day}`,
      `${monthFull}\\s*${day}`,
      `${monthAbbr}\\s*${day}(st|nd|rd|th)?`,
      `${monthFull}\\s*${day}(st|nd|rd|th)?`,
    ];
    
    for (const pattern of dayPatterns) {
      if (new RegExp(pattern, "i").test(text)) {
        return i;
      }
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
      text.includes(`${hour12}:00 ${ampm}`) ||
      (hour >= 17 && text.includes("evening")) ||
      (hour >= 12 && hour < 17 && text.includes("afternoon")) ||
      (hour < 12 && text.includes("morning"))
    ) {
      return i;
    }
  }

  // Fallback: if message contains just a number that matches a slot
  const justNumber = text.match(/^(\d)$/);
  if (justNumber) {
    const num = parseInt(justNumber[1], 10);
    if (num >= 1 && num <= availableSlots.length) {
      return num - 1;
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
 * 
 * @param {Object} params
 * @param {Object} params.contact - GHL contact object
 * @param {Object} params.aiMeta - AI metadata (consultMode, preferredTimeWindow, preferredDay)
 * @param {Object} params.contactProfile - Contact profile with tattoo info
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
    const preferredDay = aiMeta?.preferredDay || null;

    // Get calendar ID
    const calendarId = getCalendarIdForArtist(artist, consultMode);
    if (!calendarId) {
      console.warn(`⚠️ Could not find calendar for artist ${artist}, mode ${consultMode}`);
      return null;
    }

    // Generate suggested slots with preferences
    const slots = generateSuggestedSlots({
      preferredTimeWindow,
      preferredDay,
    });
    
    if (slots.length === 0) {
      console.warn("⚠️ Could not generate time slots");
      return null;
    }

    console.log(`📅 Generated ${slots.length} time slots for ${artist} (${consultMode}):`, 
      preferredDay ? `(requested: ${preferredDay})` : "", 
      slots.map(s => s.displayText));

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

    // Determine assigned user for this artist (required by GHL)
    const assignedUserId = getAssignedUserIdForArtist(artist);
    if (!assignedUserId) {
      console.warn(`⚠️ No assignedUserId found for artist "${artist}", appointment may fail`);
    }

    // Create appointment with status "new" (on hold)
    const appointment = await createAppointment({
      calendarId,
      contactId,
      startTime,
      endTime,
      title,
      description,
      appointmentStatus: APPOINTMENT_STATUS.NEW,
      assignedUserId,
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

