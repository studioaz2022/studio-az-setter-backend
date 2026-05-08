// blockedSlotClassifier.js
//
// Classifies a GHL blocked slot into one of:
//   - synced_appointment: a real appointment from an external booking platform
//                         (Google Calendar 2-way sync, kiosk, Square, etc.)
//   - informal_appointment: a barber-entered name block — likely a real client
//                           that wasn't booked through GHL
//   - break_blocked: a recurring break (lunch, etc.) the barber blocked manually
//                    instead of configuring as a scheduled break
//   - manually_blocked: true personal time (day off, sick, vacation, memorial)
//
// See GRID_WALK_UTILIZATION_PLAN.md "Synced Appointment Detection" section
// for the full rule set and worked examples.

const BREAK_KEYWORDS = [
  "lunch",
  "break",
  "almuerzo",
  "comida",
  "descanso",
  "food",
  "eat",
  "meal",
  "rest",
];

// Keywords that indicate a real "personal time" block (NOT a name)
const BLOCK_KEYWORDS = [
  "blocked",
  "block",
  "off",
  "unavailable",
  "vacation",
  "pto",
  "time",
  "day",
  "personal",
  "sick",
  "out",
  "holiday",
];

/**
 * Classify a single blocked slot into one of the four categories above.
 * @param {object} block - GHL Blocked Slots API event ({ title, notes, ... })
 * @returns {string} - "synced_appointment" | "informal_appointment" | "break_blocked" | "manually_blocked"
 */
function classifyBlockedSlot(block) {
  const title = (block.title || "").trim();
  const notes = block.notes || "";
  const titleLower = title.toLowerCase();

  // Rule 1: Structured notes from external booking platform.
  // The kiosk and other booking platforms write "Reservada por <name>\n<email>\n<phone>..." into the notes.
  // This is the highest-confidence signal that a real client is in this slot.
  if (notes.includes("Reservada por") || notes.includes("Reserved by")) {
    return "synced_appointment";
  }

  // Rule 2: Service title pattern — e.g. "HAIRCUT (Carlos Carrillo)" or "Haircut & Eyebrows (Tomas Sanchez)".
  // Match "<service text> (<name>)" where the parenthetical content looks like a person's name:
  //   - 1-4 words, mostly letters (allowing ' . , - and accented chars)
  //   - excludes scores like "(0-3)", URLs, or anything with digits
  // Reject false positives like "Club León - Club Tijuana (0-3)".
  const parenMatch = title.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const inside = parenMatch[2].trim();
    const insideWords = inside.split(/\s+/);
    const looksLikeName =
      insideWords.length >= 1 &&
      insideWords.length <= 4 &&
      // Each word must be mostly letters (allow apostrophes, hyphens, periods)
      insideWords.every((w) => /^[A-Za-zÁÉÍÓÚÑÜáéíóúñü'.\-]+$/.test(w));
    if (looksLikeName) {
      return "synced_appointment";
    }
  }

  // Rule 3: Break-like keywords — recurring lunch/break the barber blocked manually.
  // These should reduce the denominator (treated like a scheduled break),
  // not penalize availability.
  if (
    title.length > 0 &&
    BREAK_KEYWORDS.some((kw) => titleLower.includes(kw))
  ) {
    return "break_blocked";
  }

  // Rule 4: Informal name block — 1-3 short words (a name) + optional phone number.
  // Phone numbers get stripped before counting words, so "Tobi 6123874866" is 1 word + phone.
  if (title.length > 0) {
    const words = title.split(/\s+/);
    const wordsNoPhone = words.filter((w) => !/^\d{7,}$/.test(w));
    const hasPhone = words.some((w) => /^\d{7,}$/.test(w));

    if (wordsNoPhone.length >= 1 && wordsNoPhone.length <= 3) {
      const isBlockKeyword = wordsNoPhone.some((w) =>
        BLOCK_KEYWORDS.includes(w.toLowerCase())
      );
      if (!isBlockKeyword) {
        // Looks like a name — informal walk-in/phone booking.
        // If it also has a phone number, it's confident enough to call synced.
        return hasPhone ? "synced_appointment" : "informal_appointment";
      }
    }
  }

  // Rule 5 & 6: Personal/memorial text or empty title → true manual block.
  return "manually_blocked";
}

module.exports = {
  classifyBlockedSlot,
  BREAK_KEYWORDS,
  BLOCK_KEYWORDS,
};
