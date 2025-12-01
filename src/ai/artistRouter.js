// artistRouter.js
// Style-based artist assignment and routing logic

const { getContact, updateSystemFields, updateTattooFields } = require("../../ghlClient");
const { SYSTEM_FIELDS, TATTOO_FIELDS, CALENDARS } = require("../config/constants");

/**
 * Artist style mappings
 * Maps tattoo styles to preferred artists
 */
const ARTIST_STYLE_MAP = {
  realism: ["Joan"], // Realism → Joan
  "fine line": ["Artist2"], // Fine line → Artist2 (update with actual artist name)
  traditional: ["Artist3"], // Traditional → Artist3 (update with actual artist name)
  "black and grey": ["Joan"], // Black and grey → Joan
  color: ["Artist4"], // Color → Artist4 (update with actual artist name)
  // Add more style mappings as needed
};

/**
 * Artist workload tracking (placeholder - should be fetched from GHL or external system)
 * Format: { artistName: currentWorkloadCount }
 */
let artistWorkloads = {
  Joan: 0,
  Artist2: 0,
  Artist3: 0,
  Artist4: 0,
};

/**
 * Get artist preference from contact (from URL parameter, custom field, or tags)
 */
function getArtistPreferenceFromContact(contact) {
  const cf = contact.customField || contact.customFields || {};
  const tags = contact.tags || [];

  // 1. Check custom field
  const inquiredTechnician = cf[TATTOO_FIELDS.INQUIRED_TECHNICIAN];
  if (inquiredTechnician) {
    return inquiredTechnician;
  }

  // 2. Check tags for URL parameter override (e.g., ?tech=Joan)
  for (const tag of tags) {
    if (typeof tag === "string" && tag.toLowerCase().startsWith("tech:")) {
      const artist = tag.split(":")[1]?.trim();
      if (artist) {
        return artist;
      }
    }
  }

  return null;
}

/**
 * Get tattoo style from contact
 */
function getTattooStyleFromContact(contact) {
  const cf = contact.customField || contact.customFields || {};
  const tattooStyle = cf[TATTOO_FIELDS.TATTOO_STYLE] || "";
  return String(tattooStyle).toLowerCase().trim();
}

/**
 * Find matching artists for a style
 */
function findArtistsForStyle(style) {
  const normalizedStyle = String(style).toLowerCase().trim();
  
  // Direct match
  if (ARTIST_STYLE_MAP[normalizedStyle]) {
    return ARTIST_STYLE_MAP[normalizedStyle];
  }

  // Partial match (e.g., "black and grey realism" → ["Joan"])
  for (const [key, artists] of Object.entries(ARTIST_STYLE_MAP)) {
    if (normalizedStyle.includes(key) || key.includes(normalizedStyle)) {
      return artists;
    }
  }

  // Default fallback (could be a general artist or null)
  return null;
}

/**
 * Select artist with workload balancing
 * Given a list of candidate artists, returns the one with the lowest workload
 */
function selectArtistWithWorkloadBalancing(candidateArtists) {
  if (!candidateArtists || candidateArtists.length === 0) {
    return null;
  }

  // If only one candidate, return it
  if (candidateArtists.length === 1) {
    return candidateArtists[0];
  }

  // Find artist with lowest workload
  let selectedArtist = candidateArtists[0];
  let lowestWorkload = artistWorkloads[selectedArtist] || 0;

  for (const artist of candidateArtists) {
    const workload = artistWorkloads[artist] || 0;
    if (workload < lowestWorkload) {
      lowestWorkload = workload;
      selectedArtist = artist;
    }
  }

  return selectedArtist;
}

/**
 * Determine artist for a contact
 * Priority:
 * 1. URL parameter override (?tech=Joan)
 * 2. Contact's artist preference
 * 3. Style-based routing
 * 4. Workload balancing
 */
function determineArtist(contact) {
  // 1. Check for URL parameter override or explicit preference
  const preferredArtist = getArtistPreferenceFromContact(contact);
  if (preferredArtist) {
    console.log(`✅ Using preferred artist from contact: ${preferredArtist}`);
    return preferredArtist;
  }

  // 2. Style-based routing
  const tattooStyle = getTattooStyleFromContact(contact);
  if (tattooStyle) {
    const candidateArtists = findArtistsForStyle(tattooStyle);
    if (candidateArtists && candidateArtists.length > 0) {
      const selectedArtist = selectArtistWithWorkloadBalancing(candidateArtists);
      console.log(`✅ Selected artist based on style "${tattooStyle}": ${selectedArtist}`);
      return selectedArtist;
    }
  }

  // 3. Default fallback (could be null or a general artist)
  console.warn(`⚠️ Could not determine artist for contact ${contact.id || contact._id}`);
  return null;
}

/**
 * Assign artist to contact (should be called AFTER deposit is paid)
 */
async function assignArtistToContact(contactId, artistName) {
  if (!contactId || !artistName) {
    throw new Error("contactId and artistName are required for assignArtistToContact");
  }

  try {
    // Update tattoo field with assigned artist
    await updateTattooFields(contactId, {
      [TATTOO_FIELDS.INQUIRED_TECHNICIAN]: artistName,
    });

    // Update system fields
    await updateSystemFields(contactId, {
      assigned_artist: artistName,
      artist_assigned_at: new Date().toISOString(),
    });

    // Increment artist workload (placeholder - should be persisted)
    if (artistWorkloads[artistName] !== undefined) {
      artistWorkloads[artistName] = (artistWorkloads[artistName] || 0) + 1;
    }

    console.log(`✅ Assigned artist ${artistName} to contact ${contactId}`);
  } catch (err) {
    console.error(`❌ Error assigning artist to contact ${contactId}:`, err.message || err);
    throw err;
  }
}

/**
 * Auto-assign artist for a contact (called after deposit paid)
 */
async function autoAssignArtist(contactId) {
  try {
    const contact = await getContact(contactId);
    if (!contact) {
      throw new Error(`Contact ${contactId} not found`);
    }

    // Check if deposit is paid
    const cf = contact.customField || contact.customFields || {};
    const depositPaid = cf[SYSTEM_FIELDS.DEPOSIT_PAID] === "Yes" || cf[SYSTEM_FIELDS.DEPOSIT_PAID] === true;

    if (!depositPaid) {
      console.warn(`⚠️ Cannot assign artist - deposit not paid for contact ${contactId}`);
      return null;
    }

    // Check if already assigned
    const alreadyAssigned = cf[TATTOO_FIELDS.INQUIRED_TECHNICIAN];
    if (alreadyAssigned) {
      console.log(`ℹ️ Artist already assigned to contact ${contactId}: ${alreadyAssigned}`);
      return alreadyAssigned;
    }

    // Determine and assign artist
    const artist = determineArtist(contact);
    if (artist) {
      await assignArtistToContact(contactId, artist);
      return artist;
    }

    return null;
  } catch (err) {
    console.error(`❌ Error in autoAssignArtist for contact ${contactId}:`, err.message || err);
    throw err;
  }
}

/**
 * Update artist workload (should be called when artist completes work or gets new assignment)
 */
function updateArtistWorkload(artistName, delta) {
  if (artistWorkloads[artistName] !== undefined) {
    artistWorkloads[artistName] = Math.max(0, (artistWorkloads[artistName] || 0) + delta);
  }
}

/**
 * Get calendar ID for an artist and consult mode
 * @param {string} artistName - Artist name (e.g. "Joan", "Andrew")
 * @param {string} consultMode - "online" or "in_person"
 * @returns {string|null} Calendar ID or null if not found
 */
function getCalendarIdForArtist(artistName, consultMode = "online") {
  const normalizedArtist = String(artistName).trim();
  const normalizedMode = String(consultMode).toLowerCase().trim();

  if (normalizedArtist.toLowerCase() === "joan") {
    return normalizedMode === "in_person" || normalizedMode === "in-person"
      ? CALENDARS.JOAN_IN_PERSON
      : CALENDARS.JOAN_ONLINE;
  }

  if (normalizedArtist.toLowerCase() === "andrew") {
    return normalizedMode === "in_person" || normalizedMode === "in-person"
      ? CALENDARS.ANDREW_IN_PERSON
      : CALENDARS.ANDREW_ONLINE;
  }

  console.warn(
    `⚠️ Unknown artist "${artistName}" for calendar selection, defaulting to Joan online`
  );
  return CALENDARS.JOAN_ONLINE; // Default fallback
}

module.exports = {
  determineArtist,
  assignArtistToContact,
  autoAssignArtist,
  updateArtistWorkload,
  getCalendarIdForArtist,
  ARTIST_STYLE_MAP,
  artistWorkloads,
};

