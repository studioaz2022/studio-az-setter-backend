/**
 * Qualified Lead Handler
 * 
 * Handles task creation for qualified leads based on consultation type,
 * language preference, and tattoo size.
 * 
 * Route Configuration:
 * - Route A: Admin leads small consultations, artist fills Pre-Consultation Notes
 * - Route B: Artist + Translator always on call together (no tasks needed)
 */

const { sendAppEvent, EVENT_TYPES } = require('../clients/appEventClient');

// Read route configuration from environment variable
// Default to "A" if not set
const CONSULTATION_ROUTE = process.env.CONSULTATION_ROUTE || "A";

/**
 * Determine if a task needs to be created based on consultation parameters
 * 
 * @param {Object} params
 * @param {string} params.consultationType - Type of consultation (message, online, appointment, in_person)
 * @param {boolean} params.isSpanishOrComfortable - Whether lead speaks Spanish or is comfortable with Spanish
 * @param {string} params.tattooSize - Size of tattoo from intake form
 * @returns {Object} Decision object with taskType and reason
 */
function determineTaskNeeded({ consultationType, isSpanishOrComfortable, tattooSize }) {
  // Message consultation always needs artist introduction task
  // Artist needs to introduce themselves and know it's a message-based consultation
  if (consultationType === "message") {
    return { 
      taskType: "artist_introduction", 
      reason: "Message-based consultation - artist needs to introduce themselves" 
    };
  }
  
  // Spanish/comfortable leads with video consultation - no task needed
  // The appointment will sync naturally and artist can communicate directly
  if (isSpanishOrComfortable) {
    return { 
      taskType: null, 
      reason: "Spanish-comfortable video consultation - no task needed" 
    };
  }
  
  // English-only video consultations - check route and size
  const sizeNormalized = (tattooSize || "").toLowerCase();
  
  // Check if this is a small/fine line/medium low coverage tattoo
  const isSmallMediumLow = 
    sizeNormalized.includes("fine line") ||
    sizeNormalized.includes("línea fina") ||
    sizeNormalized.includes("small") ||
    sizeNormalized.includes("pequeño") ||
    sizeNormalized.includes("medium, low coverage") ||
    sizeNormalized.includes("medium low coverage") ||
    sizeNormalized.includes("mediano, cobertura baja") ||
    sizeNormalized.includes("mediano cobertura baja");
  
  // Route A: Admin leads small consultations
  // Artist needs to fill out Pre-Consultation Notes before the admin-led consultation
  if (CONSULTATION_ROUTE === "A" && isSmallMediumLow) {
    return { 
      taskType: "pre_consultation_notes", 
      reason: "Route A: Admin-led consultation - artist needs to prepare notes" 
    };
  }
  
  // Route B OR medium high/large tattoos - Artist + Translator on call together
  // No task needed, both will be present on the consultation
  return { 
    taskType: null, 
    reason: `Route ${CONSULTATION_ROUTE}: Artist + Translator on call together - no task needed` 
  };
}

/**
 * Handle task creation for qualified leads after deposit payment
 * 
 * @param {Object} params
 * @param {string} params.contactId - GHL contact ID
 * @param {string} params.contactName - Display name of contact
 * @param {string} params.consultationType - Type of consultation selected
 * @param {boolean} params.isSpanishOrComfortable - Whether lead speaks Spanish
 * @param {string} params.tattooSize - Size of tattoo from intake
 * @param {string} params.assignedArtist - Name of assigned artist
 */
async function handleQualifiedLeadTasks({ 
  contactId, 
  contactName, 
  consultationType, 
  isSpanishOrComfortable, 
  tattooSize,
  assignedArtist 
}) {
  console.log(`\n📋 Processing qualified lead task for: ${contactName}`);
  console.log(`   Consultation Type: ${consultationType}`);
  console.log(`   Spanish/Comfortable: ${isSpanishOrComfortable}`);
  console.log(`   Tattoo Size: ${tattooSize}`);
  console.log(`   Assigned Artist: ${assignedArtist}`);
  console.log(`   Current Route: ${CONSULTATION_ROUTE}`);
  
  const decision = determineTaskNeeded({ 
    consultationType, 
    isSpanishOrComfortable, 
    tattooSize 
  });
  
  if (!decision.taskType) {
    console.log(`ℹ️ No task needed: ${decision.reason}`);
    return { taskCreated: false, reason: decision.reason };
  }
  
  try {
    // Send task creation event to webhook server via appEventClient
    await sendAppEvent(EVENT_TYPES.CREATE_TASK, contactId, {
      taskType: decision.taskType,
      contactName,
      assignedArtist,
      consultationType,
      metadata: {
        consultation_type: consultationType,
        tattoo_size: tattooSize,
        reason: decision.reason,
        route: CONSULTATION_ROUTE
      }
    });
    
    console.log(`✅ Task creation event sent: ${decision.taskType} for ${contactName}`);
    return { taskCreated: true, taskType: decision.taskType, reason: decision.reason };
  } catch (error) {
    console.error(`❌ Failed to send task creation event:`, error.message || error);
    return { taskCreated: false, error: error.message };
  }
}

/**
 * Get the current consultation route configuration
 * @returns {string} Current route ("A" or "B")
 */
function getCurrentRoute() {
  return CONSULTATION_ROUTE;
}

module.exports = { 
  handleQualifiedLeadTasks, 
  determineTaskNeeded,
  getCurrentRoute
};

