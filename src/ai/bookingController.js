// bookingController.js
// Handles appointment booking orchestration

const { getContact, updateSystemFields } = require("../../ghlClient");
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
const {
  CALENDARS,
  TRANSLATOR_CALENDARS,
  HOLD_CONFIG,
  APPOINTMENT_STATUS,
} = require("../config/constants");
const { sendConversationMessage } = require("../../ghlClient");
const { boolField, normalizeCustomFields } = require("./opportunityManager");

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

const MONTH_MAP = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

function hoursForWindow(preferredTimeWindow = null) {
  if (!preferredTimeWindow) return [17, 18]; // default: early evening options
  const tw = preferredTimeWindow.toLowerCase();
  if (tw.includes("morning")) return [10, 11];
  if (tw.includes("afternoon")) return [14, 15];
  if (tw.includes("evening") || tw.includes("night")) return [17, 18, 19];
  return [17];
}

function nextDateFromMonthDay(monthIndex, day, now = new Date()) {
  const candidate = new Date(now);
  candidate.setHours(0, 0, 0, 0);
  candidate.setMonth(monthIndex, day);
  if (candidate <= now) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }
  return candidate;
}

/**
 * Extract explicit dates from a message (supports "Dec 10", "December 11th", "10th or 11th")
 * Returns an array of Date objects (deduped, future-dated)
 */
function extractDatesFromMessage(messageText) {
  if (!messageText) return [];
  const now = new Date();
  const dates = [];
  const seen = new Set();
  const text = String(messageText);

  // Month + day (e.g., "Dec 10", "December 11th")
  const monthDayRegex = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(\d{1,2})(st|nd|rd|th)?\b/gi;
  let match;
  while ((match = monthDayRegex.exec(text)) !== null) {
    const monthStr = match[1].toLowerCase().slice(0, 3);
    const day = parseInt(match[2], 10);
    const monthIndex = MONTH_MAP[monthStr];
    if (monthIndex !== undefined && day >= 1 && day <= 31) {
      const d = nextDateFromMonthDay(monthIndex, day, now);
      const key = d.toISOString().slice(0, 10);
      if (!seen.has(key)) {
        seen.add(key);
        dates.push(d);
      }
    }
  }

  // Bare day-of-month with suffix (e.g., "10th", "11th") when no month is provided
  const dayOnlyRegex = /\b(\d{1,2})(st|nd|rd|th)\b/gi;
  while ((match = dayOnlyRegex.exec(text)) !== null) {
    const day = parseInt(match[1], 10);
    if (day < 1 || day > 31) continue;
    const candidate = new Date(now);
    candidate.setHours(0, 0, 0, 0);
    candidate.setDate(day);
    // If already passed this month, bump to next month
    if (candidate <= now) {
      candidate.setMonth(candidate.getMonth() + 1);
    }
    const key = candidate.toISOString().slice(0, 10);
    if (!seen.has(key)) {
      seen.add(key);
      dates.push(candidate);
    }
  }

  // Sort ascending
  dates.sort((a, b) => a.getTime() - b.getTime());
  return dates;
}

/**
 * Generate slots for specific dates (multiple days), respecting preferred time window
 */
function generateSlotsForSpecificDates({ dates = [], preferredTimeWindow = null, maxPerDate = 2 }) {
  const now = new Date();
  const slots = [];
  const hours = hoursForWindow(preferredTimeWindow);

  for (const date of dates) {
    for (let i = 0; i < hours.length && i < maxPerDate; i++) {
      const hour = hours[i];
      const slotDate = new Date(date);
      slotDate.setHours(hour, 0, 0, 0);

      if (slotDate > now) {
        const endTime = new Date(slotDate);
        endTime.setMinutes(endTime.getMinutes() + 30);

        slots.push({
          startTime: slotDate.toISOString(),
          endTime: endTime.toISOString(),
          displayText: formatSlotDisplay(slotDate),
        });
      }
    }
  }

  return slots;
}

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

function getTranslatorCalendarsForMode(consultMode = "online") {
  const isInPerson = consultMode === "in_person" || consultMode === "in-person";
  return isInPerson
    ? [
        { name: "Lionel", calendarId: TRANSLATOR_CALENDARS.LIONEL_IN_PERSON },
        { name: "Maria", calendarId: TRANSLATOR_CALENDARS.MARIA_IN_PERSON },
      ]
    : [
        { name: "Lionel", calendarId: TRANSLATOR_CALENDARS.LIONEL_ONLINE },
        { name: "Maria", calendarId: TRANSLATOR_CALENDARS.MARIA_ONLINE },
      ];
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
 * - "the 10th", "10th at 5pm"
 */
function parseTimeSelection(messageText, availableSlots) {
  if (!messageText || !availableSlots || availableSlots.length === 0) {
    return null;
  }

  const text = String(messageText).toLowerCase().trim();
  const hasExplicitTime =
    /(\d{1,2})(?::\d{2})?\s*(am|pm)/i.test(text) ||
    /\b(morning|afternoon|evening|night)\b/i.test(text);

  // === GUARD: Don't treat availability questions or multiple dates as selections ===
  const isAskingForAvailability = /\b(what times|when are you|available|availability|what works|what days)\b/i.test(text);
  const dateMatches = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*\d{1,2}/gi) || [];
  const dayMatches = text.match(/\b\d{1,2}(st|nd|rd|th)\b/gi) || [];
  
  if (isAskingForAvailability) {
    console.log("📅 Detected availability question - not a slot selection");
    return null;
  }
  
  const isAskingForTimesOnDate = /\b(what times|times on|available on|free on)\b.*\d{1,2}/i.test(text);
  if (isAskingForTimesOnDate) {
    console.log("📅 Asking for times on a specific date - not a slot selection");
    return null;
  }

  if (dateMatches.length > 1 || dayMatches.length > 1) {
    console.log("📅 Detected multiple dates mentioned - not a slot selection, asking for clarification");
    return null;
  }

  // === Check for explicit option numbers first ===
  const optionMatch = text.match(/option\s*#?(\d)/i) || text.match(/^#?(\d)$/);
  if (optionMatch) {
    const num = parseInt(optionMatch[1], 10);
    if (num >= 1 && num <= availableSlots.length) {
      console.log(`✅ Matched option number: ${num}`);
      return num - 1;
    }
  }

  // === Check for ordinal references ("first", "second", "third") ===
  const ordinals = ["first", "second", "third", "1st", "2nd", "3rd"];
  for (let i = 0; i < Math.min(ordinals.length, availableSlots.length); i++) {
    const ordinalIdx = i % 3;
    if (text.includes(ordinals[ordinalIdx]) || text.includes(ordinals[ordinalIdx + 3])) {
      console.log(`✅ Matched ordinal: ${ordinals[ordinalIdx]}`);
      return ordinalIdx;
    }
  }

  // === Check for day names (full and abbreviated) ===
  const daysFull = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const daysAbbr = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  
  for (let i = 0; i < availableSlots.length; i++) {
    const slotDate = new Date(availableSlots[i].startTime);
    const dayIndex = slotDate.getDay();
    const dayNameFull = daysFull[dayIndex];
    const dayNameAbbr = daysAbbr[dayIndex];
    
    if (text.includes(dayNameFull) || new RegExp(`\\b${dayNameAbbr}\\b`).test(text)) {
      if (!hasExplicitTime) {
        console.log(`📅 Day name mentioned without time (${dayNameFull}) - not selecting`);
        return null;
      }
      console.log(`✅ Matched day name with time: ${dayNameFull} → slot ${i + 1}`);
      return i;
    }
  }

  // === Check for month + day mentions (e.g., "Dec 3", "December 3rd") ===
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
    
    const dayPatterns = [
      `${monthAbbr}\\s*${day}(st|nd|rd|th)?\\b`,
      `${monthFull}\\s*${day}(st|nd|rd|th)?\\b`,
    ];
    
    for (const pattern of dayPatterns) {
      if (new RegExp(pattern, "i").test(text)) {
        if (!hasExplicitTime) {
          console.log(`📅 Month+day mentioned without time (${monthAbbr} ${day}) - not selecting`);
          return null;
        }
        console.log(`✅ Matched month+day with time: ${monthAbbr} ${day} → slot ${i + 1}`);
        return i;
      }
    }
  }

  // === NEW: Handle bare day-of-month like "the 10th", "10th at 5pm" ===
  const dayOfMonthMatch = text.match(/\bthe?\s*(\d{1,2})(st|nd|rd|th)?\b/i);
  if (dayOfMonthMatch) {
    const requestedDay = parseInt(dayOfMonthMatch[1], 10);
    const timeMatch = text.match(/(\d{1,2})(?::\d{2})?\s*(am|pm)/i);
    
    console.log(`📅 Looking for day-of-month: ${requestedDay}${timeMatch ? ` at ${timeMatch[1]}${timeMatch[2]}` : ''}`);
    
    if (!timeMatch) {
      console.log(`📅 Day-of-month mentioned without time (${requestedDay}) - not selecting`);
      return null;
    }
    
    for (let i = 0; i < availableSlots.length; i++) {
      const slotDate = new Date(availableSlots[i].startTime);
      const slotDay = slotDate.getDate();
      const slotHour = slotDate.getHours();
      const slotHour12 = slotHour > 12 ? slotHour - 12 : slotHour === 0 ? 12 : slotHour;
      const slotAmpm = slotHour >= 12 ? "pm" : "am";

      if (slotDay === requestedDay) {
        const reqHour = parseInt(timeMatch[1], 10);
        const reqAmpm = timeMatch[2].toLowerCase();
        if (reqHour === slotHour12 && reqAmpm === slotAmpm) {
          console.log(`✅ Matched day-of-month ${requestedDay} at ${reqHour}${reqAmpm} → slot ${i + 1}`);
          return i; // Exact day+time match
        }
      }
    }
    
    // If they specified a day-of-month but no slot matches, return null to trigger clarification
    console.log(`⚠️ Day-of-month ${requestedDay} not found in available slots`);
    return null;
  }

  // === Check for time mentions (e.g. "5pm", "5:00", "evening") - LAST RESORT ===
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
      console.log(`✅ Matched time ${hour12}${ampm} → slot ${i + 1}`);
      return i;
    }
  }

  // === Fallback: if message contains just a number that matches a slot ===
  const justNumber = text.match(/^(\d)$/);
  if (justNumber) {
    const num = parseInt(justNumber[1], 10);
    if (num >= 1 && num <= availableSlots.length) {
      console.log(`✅ Matched bare number: ${num}`);
      return num - 1;
    }
  }

  console.log("⚠️ Could not parse time selection from message");
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
  const {
    consultMode = "online",
    preferredTimeWindow = null,
    preferredDay = null,
    baseSlots = null,
  } = options;

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
  const baseSlotsToUse = Array.isArray(baseSlots) && baseSlots.length > 0
    ? baseSlots
    : generateSuggestedSlots({
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

    for (const slot of baseSlotsToUse) {
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
 * Generate slots that include translator pairing (both in-person and online variants)
 */
function generateSlotsWithTranslator(options = {}) {
  const {
    consultMode = "online",
    preferredTimeWindow = null,
    preferredDay = null,
    baseSlots = null,
  } = options;
  const baseSlotsToUse = Array.isArray(baseSlots) && baseSlots.length > 0
    ? baseSlots
    : generateSuggestedSlots({ preferredTimeWindow, preferredDay });
  const translators = getTranslatorCalendarsForMode(consultMode);

  const slots = [];
  for (const slot of baseSlotsToUse) {
    for (const t of translators) {
      slots.push({
        ...slot,
        translator: t.name,
        translatorCalendarId: t.calendarId,
      });
    }
  }

  return slots;
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
    const extractedDates = extractDatesFromMessage(messageText);
    const translatorNeeded =
      aiMeta?.translatorNeeded === true ||
      contactProfile?.translatorNeeded === true ||
      contactProfile?.translatorNeeded === "Yes";

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
      const baseSlots = extractedDates.length > 0
        ? generateSlotsForSpecificDates({
            dates: extractedDates,
            preferredTimeWindow,
            maxPerDate: 2,
          })
        : generateSuggestedSlots({
            preferredTimeWindow,
            preferredDay,
          });
      const translatorSlots = translatorNeeded
        ? generateSlotsWithTranslator({
            consultMode,
            preferredTimeWindow,
            preferredDay,
            baseSlots,
          })
        : null;

      // Tag slots with artist info
      const sourceSlots = translatorNeeded && translatorSlots ? translatorSlots : baseSlots;
      const slots = sourceSlots.map((slot) => ({
        ...slot,
        artist: explicitArtist,
        calendarId,
        translator: slot.translator || null,
        translatorCalendarId: slot.translatorCalendarId || null,
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
        translatorNeeded,
      };
    } else {
      // ========== TIME-FIRST MODE ==========
      // No explicit preference - show times from ALL artists, sorted by workload
      console.log("🕐 TIME-FIRST MODE: No explicit artist preference, showing all artists' availability");

      const baseSlots = extractedDates.length > 0
        ? generateSlotsForSpecificDates({
            dates: extractedDates,
            preferredTimeWindow,
            maxPerDate: 2,
          })
        : generateSuggestedSlots({
            preferredTimeWindow,
            preferredDay,
          });

      const allSlots = await generateSlotsFromAllArtists({
        consultMode,
        preferredTimeWindow,
        preferredDay,
        baseSlots,
      });
      const translatorSlots = translatorNeeded
        ? generateSlotsWithTranslator({
            consultMode,
            preferredTimeWindow,
            preferredDay,
            baseSlots,
          })
        : null;

      if (translatorNeeded && translatorSlots && translatorSlots.length > 0) {
        const slotsWithTranslators = [];
        const translators = getTranslatorCalendarsForMode(consultMode);

        for (const base of allSlots) {
          for (const t of translators) {
            slotsWithTranslators.push({
              ...base,
              translator: t.name,
              translatorCalendarId: t.calendarId,
            });
          }
        }
        // Replace with translated slots
        allSlots.length = 0;
        slotsWithTranslators.forEach((s) => allSlots.push(s));
      }

      if (allSlots.length === 0) {
        console.warn("⚠️ Could not generate time slots from any artist");
        return null;
      }

      // Select best slots to present (unique times, prefer lower workload)
      const maxSlots = extractedDates.length > 1 ? Math.min(6, extractedDates.length * 2) : 3;
      const slotsToPresent = selectBestSlotsForPresentation(allSlots, maxSlots);

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
        translatorNeeded,
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
  translatorNeeded = false,
  translatorCalendarId = null,
  translatorName = null,
}) {
  try {
    const contact = await getContact(contactId);
    if (!contact) {
      throw new Error(`Contact ${contactId} not found`);
    }

    // Check if deposit is already paid - normalize custom fields
    const rawCf = contact?.customField || contact?.customFields || {};
    const cf = typeof normalizeCustomFields === "function" ? normalizeCustomFields(rawCf) : rawCf;
    const depositPaid =
      typeof boolField === "function"
        ? boolField(cf.deposit_paid)
        : cf.deposit_paid === "Yes" || cf.deposit_paid === true;

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

    let translatorAppointment = null;

    if (translatorNeeded && translatorCalendarId) {
      const translatorTitle = `Translator for consult (${artist})`;
      const translatorDescription = `Translator: ${translatorName || "Translator"} for consult with ${artist}`;

      try {
        translatorAppointment = await createAppointment({
          calendarId: translatorCalendarId,
          contactId,
          startTime,
          endTime,
          title: translatorTitle,
          description: translatorDescription,
          appointmentStatus,
          address: consultMode === "online" ? "Zoom" : null,
          meetingLocationType: consultMode === "online" ? "custom" : null,
        });
      } catch (translatorErr) {
        console.error("❌ Error creating translator appointment:", translatorErr.message || translatorErr);
      }
    }

    console.log(`✅ Created appointment (status: ${appointmentStatus}):`, {
      appointmentId: appointment.id,
      calendarId,
      contactId,
      startTime,
      appointmentStatus,
      depositPaid,
      translatorAppointmentId: translatorAppointment?.id || null,
    });

    if (translatorAppointment?.id) {
      try {
        await updateSystemFields(contactId, {
          translator_appointment_id: translatorAppointment.id,
        });
      } catch (err) {
        console.error("❌ Failed to persist translator appointment id:", err.message || err);
      }
    }

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

