// bookingController.js
// Handles appointment booking orchestration

const { getContact } = require("../../ghlClient");
const {
  determineArtist,
  getCalendarIdForArtist,
  getAssignedUserIdForArtist,
  getArtistWithLowestWorkload,
  getArtistWorkloads,
  getArtistPreferenceFromContact,
  detectArtistMention,
  assignArtistToContact,
} = require("./artistRouter");
const {
  createAppointment,
  listAppointmentsForContact,
  getConsultAppointmentsForContact,
} = require("../clients/ghlCalendarClient");
const { CALENDARS, HOLD_CONFIG, APPOINTMENT_STATUS } = require("../config/constants");
const { sendConversationMessage } = require("../../ghlClient");

// Active artists for time-first slot generation
const ACTIVE_ARTISTS = ["Joan", "Andrew"];

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
async function selectArtistByAvailability(consultMode = "online") {
  const artist = await getArtistWithLowestWorkload();
  if (!artist) {
    console.warn(
      `⚠️ selectArtistByAvailability could not find artist for mode ${consultMode}, defaulting to Joan`
    );
    return "Joan";
  }
  return artist;
}

/**
 * Check if contact has an EXPLICIT artist preference
 * Returns the artist name if explicit preference exists, null otherwise
 * 
 * Explicit preferences include:
 * - URL parameter (?technician=Joan)
 * - Custom field set (inquired_technician)
 * - Artist mention in current message
 */
function getExplicitArtistPreference(contact, messageText = null) {
  // 1. Check contact's stored preference (URL param or custom field)
  const storedPreference = getArtistPreferenceFromContact(contact);
  if (storedPreference) {
    return storedPreference;
  }

  // 2. Check for artist mention in current message
  if (messageText) {
    const mentionedArtist = detectArtistMention(messageText);
    if (mentionedArtist) {
      return mentionedArtist;
    }
  }

  return null;
}

/**
 * Generate slots from ALL artists (time-first approach)
 * Each slot is tagged with artist info, sorted by workload (lower-workload artist times first)
 * 
 * @param {Object} options
 * @param {string} options.consultMode - "online" or "in_person"
 * @param {string} options.preferredTimeWindow - "morning", "afternoon", "evening"
 * @param {string} options.preferredDay - Weekday name
 * @returns {Array} Array of slots with artist info attached
 */
async function generateSlotsFromAllArtists(options = {}) {
  const { consultMode = "online", preferredTimeWindow = null, preferredDay = null } = options;

  // Get workloads to sort artists
  const workloads = await getArtistWorkloads();
  
  // Sort artists by workload (lowest first)
  const sortedArtists = [...ACTIVE_ARTISTS].sort((a, b) => {
    const workloadA = workloads[a] || 0;
    const workloadB = workloads[b] || 0;
    return workloadA - workloadB;
  });

  console.log(`📊 Artist workloads: ${JSON.stringify(workloads)}, sorted order: ${sortedArtists.join(", ")}`);

  // Generate base time slots (same times for all artists)
  const baseSlots = generateSuggestedSlots({
    preferredTimeWindow,
    preferredDay,
  });

  // Create slots for each artist, with artist info attached
  const allSlots = [];
  
  for (const artist of sortedArtists) {
    const calendarId = getCalendarIdForArtist(artist, consultMode);
    if (!calendarId) {
      console.warn(`⚠️ No calendar found for artist ${artist}, mode ${consultMode}`);
      continue;
    }

    for (const slot of baseSlots) {
      allSlots.push({
        ...slot,
        artist,
        calendarId,
        workload: workloads[artist] || 0,
        displayTextWithArtist: `${slot.displayText} with ${artist}`,
      });
    }
  }

  // Sort slots: primary by time, secondary by workload (lower workload first for same time)
  allSlots.sort((a, b) => {
    const timeA = new Date(a.startTime).getTime();
    const timeB = new Date(b.startTime).getTime();
    
    if (timeA !== timeB) {
      return timeA - timeB; // Earlier times first
    }
    
    return a.workload - b.workload; // Lower workload first for same time
  });

  return allSlots;
}

/**
 * Select best slots to present to lead (time-first approach)
 * Picks unique time slots, preferring lower-workload artists
 * 
 * @param {Array} allSlots - All slots from all artists
 * @param {number} maxSlots - Maximum slots to return (default 3)
 * @returns {Array} Selected slots to present
 */
function selectBestSlotsForPresentation(allSlots, maxSlots = 3) {
  const selectedSlots = [];
  const usedTimes = new Set();

  for (const slot of allSlots) {
    // Skip if we already have a slot at this time
    const timeKey = slot.startTime;
    if (usedTimes.has(timeKey)) {
      continue;
    }

    selectedSlots.push(slot);
    usedTimes.add(timeKey);

    if (selectedSlots.length >= maxSlots) {
      break;
    }
  }

  return selectedSlots;
}

/**
 * Handle appointment booking when AI wants to offer times
 * 
 * TWO MODES:
 * 1. ARTIST-FIRST: If lead has explicit artist preference (URL param, custom field, or DM mention)
 *    → Only show that artist's calendar
 * 2. TIME-FIRST: If no explicit preference
 *    → Show times from ALL artists, sorted by workload (lower-workload artist times first)
 *    → When lead picks a time, book with whichever artist owns that slot
 * 
 * @param {Object} params
 * @param {Object} params.contact - GHL contact object
 * @param {Object} params.aiMeta - AI metadata (consultMode, preferredTimeWindow, preferredDay, latestMessageText)
 * @param {Object} params.contactProfile - Contact profile with tattoo info
 */
async function handleAppointmentOffer({ contact, aiMeta, contactProfile }) {
  try {
    const consultMode = aiMeta?.consultMode || "online";
    const preferredTimeWindow = aiMeta?.preferredTimeWindow || null;
    const preferredDay = aiMeta?.preferredDay || null;
    const messageText = aiMeta?.latestMessageText || null;

    // Check for EXPLICIT artist preference (URL param, custom field, DM mention)
    const explicitArtist = getExplicitArtistPreference(contact, messageText);

    if (explicitArtist) {
      // ========== ARTIST-FIRST MODE ==========
      // Lead specified an artist - only show that artist's calendar
      console.log(`🎯 ARTIST-FIRST MODE: Lead explicitly requested ${explicitArtist}`);
      
      // If artist was mentioned in message, persist it to the contact
      if (messageText && detectArtistMention(messageText)) {
        const contactId = contact.id || contact._id;
        if (contactId) {
          try {
            await assignArtistToContact(contactId, explicitArtist);
          } catch (err) {
            console.error("❌ Failed to persist artist preference:", err.message || err);
          }
        }
      }

      const calendarId = getCalendarIdForArtist(explicitArtist, consultMode);
      if (!calendarId) {
        console.warn(`⚠️ Could not find calendar for artist ${explicitArtist}, mode ${consultMode}`);
        return null;
      }

      // Generate slots for this specific artist
      const baseSlots = generateSuggestedSlots({
        preferredTimeWindow,
        preferredDay,
      });

      // Tag slots with artist info
      const slots = baseSlots.map(slot => ({
        ...slot,
        artist: explicitArtist,
        calendarId,
      }));

      if (slots.length === 0) {
        console.warn("⚠️ Could not generate time slots");
        return null;
      }

      console.log(`📅 ARTIST-FIRST: Generated ${slots.length} slots for ${explicitArtist} (${consultMode}):`, 
        slots.map(s => s.displayText));

      return {
        mode: "artist-first",
        artist: explicitArtist,
        consultMode,
        calendarId,
        slots,
      };
    } else {
      // ========== TIME-FIRST MODE ==========
      // No explicit preference - show times from ALL artists, sorted by workload
      console.log("🕐 TIME-FIRST MODE: No explicit artist preference, showing all artists' availability");

      const allSlots = await generateSlotsFromAllArtists({
        consultMode,
        preferredTimeWindow,
        preferredDay,
      });

      if (allSlots.length === 0) {
        console.warn("⚠️ Could not generate time slots from any artist");
        return null;
      }

      // Select best slots to present (unique times, prefer lower workload)
      const slotsToPresent = selectBestSlotsForPresentation(allSlots, 3);

      console.log(`📅 TIME-FIRST: Presenting ${slotsToPresent.length} slots (${consultMode}):`, 
        slotsToPresent.map(s => `${s.displayText} [${s.artist}]`));

      // For backward compatibility, use the first slot's artist as the "primary" artist
      // But each slot has its own artist info for booking
      const primaryArtist = slotsToPresent[0]?.artist || "Joan";

      return {
        mode: "time-first",
        artist: primaryArtist, // Primary artist (for display purposes)
        consultMode,
        calendarId: slotsToPresent[0]?.calendarId, // Primary calendar (for backward compat)
        slots: slotsToPresent,
        allSlots, // Full list for matching if lead picks a different time
      };
    }
  } catch (err) {
    console.error("❌ Error handling appointment offer:", err.message || err);
    return null;
  }
}

/**
 * Create appointment when user selects a time
 * If deposit is already paid, creates as CONFIRMED. Otherwise creates as NEW (hold).
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

    // Check if deposit is already paid
    const cf = contact?.customField || contact?.customFields || {};
    const depositPaid = cf.deposit_paid === "Yes" || cf.deposit_paid === true;

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

    // If deposit already paid, create as CONFIRMED. Otherwise NEW (hold).
    const appointmentStatus = depositPaid ? APPOINTMENT_STATUS.CONFIRMED : APPOINTMENT_STATUS.NEW;

    // Create appointment
    const appointment = await createAppointment({
      calendarId,
      contactId,
      startTime,
      endTime,
      title,
      description,
      appointmentStatus,
      assignedUserId,
      address: consultMode === "online" ? "Zoom" : null,
      meetingLocationType: consultMode === "online" ? "custom" : null,
    });

    console.log(`✅ Created appointment (status: ${appointmentStatus}):`, {
      appointmentId: appointment.id,
      calendarId,
      contactId,
      startTime,
      appointmentStatus,
      depositPaid,
    });

    // Only send hold message if deposit NOT paid
    if (!depositPaid) {
      const slotDisplay = formatSlotDisplay(new Date(startTime));
      const holdMessage = `Got you — I'll hold ${slotDisplay} for you.\n\nTo lock it in, just finish the $100 refundable deposit I sent.\n\nIf I don't hear back for a bit, I'll have to release the spot so someone else can grab it 🙌`;

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
    }

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
  generateSlotsFromAllArtists,
  selectBestSlotsForPresentation,
  getExplicitArtistPreference,
};

