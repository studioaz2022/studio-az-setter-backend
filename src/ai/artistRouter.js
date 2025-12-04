// artistRouter.js
// Style-based artist assignment and routing logic

const {
  getContact,
  updateSystemFields,
  updateTattooFields,
  updateContactAssignedUser,
} = require("../../ghlClient");
const {
  SYSTEM_FIELDS,
  TATTOO_FIELDS,
  CALENDARS,
  ARTIST_ASSIGNED_USER_IDS,
} = require("../config/constants");
const { searchOpportunities } = require("../clients/ghlOpportunityClient");

function formatArtistKey(key) {
  if (!key) return null;
  const lower = String(key).toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

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

const TRACKED_ARTISTS = new Set([
  "Joan",
  "Andrew",
  ...Object.keys(ARTIST_ASSIGNED_USER_IDS || {}).map((key) =>
    formatArtistKey(key)
  ),
  ...Object.values(ARTIST_STYLE_MAP || {}).flat(),
]);

function buildInitialWorkloadMap() {
  const base = {};
  Array.from(TRACKED_ARTISTS)
    .filter(Boolean)
    .forEach((name) => {
      base[name] = 0;
    });
  return base;
}

/**
 * Artist workload tracking (placeholder - should be fetched from GHL or external system)
 * Format: { artistName: currentWorkloadCount }
 */
let artistWorkloads = buildInitialWorkloadMap();

/**
 * Get assigned userId for an artist (used when creating GHL appointments)
 * @param {string} artistName
 * @returns {string|null}
 */
function getAssignedUserIdForArtist(artistName) {
  if (!artistName) return null;

  const normalized = String(artistName).toLowerCase().trim();

  if (normalized.includes("joan")) {
    return ARTIST_ASSIGNED_USER_IDS.JOAN || null;
  }

  if (normalized.includes("andrew")) {
    return ARTIST_ASSIGNED_USER_IDS.ANDREW || null;
  }

  return null;
}

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

function normalizeArtistName(name) {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.includes("joan")) return "Joan";
  if (lower.includes("andrew")) return "Andrew";
  return trimmed;
}

function detectArtistMention(messageText) {
  if (!messageText) return null;
  const text = String(messageText).toLowerCase();
  const artists = ["joan", "andrew"];

  for (const artist of artists) {
    const patterns = [
      new RegExp(`\\b${artist}\\b`, "i"),
      new RegExp(`with\\s+${artist}`, "i"),
      new RegExp(`${artist}'?s`, "i"),
      new RegExp(`artist\\s+(named\\s+)?${artist}`, "i"),
      new RegExp(`technician\\s+(named\\s+)?${artist}`, "i"),
    ];

    if (patterns.some((pattern) => pattern.test(text))) {
      return normalizeArtistName(artist);
    }
  }
  return null;
}

function mapAssignedUserIdToArtist(userId) {
  if (!userId) return null;
  const match = Object.entries(ARTIST_ASSIGNED_USER_IDS).find(
    ([, value]) => value === userId
  );
  if (!match) return null;
  return formatArtistKey(match[0]);
}

async function getArtistWorkloads() {
  const base = buildInitialWorkloadMap();

  try {
    const opportunities = await searchOpportunities({
      query: { status: "open" },
      pagination: { limit: 500, page: 1 },
    });

    opportunities.forEach((opp) => {
      const assignedUserId = opp.assignedUserId || opp.assigned_user_id;
      const artistName = mapAssignedUserIdToArtist(assignedUserId);
      if (artistName) {
        base[artistName] = (base[artistName] || 0) + 1;
      }
    });

    artistWorkloads = { ...base };
  } catch (err) {
    console.error(
      "❌ Error fetching artist workloads:",
      err.response?.data || err.message
    );
  }

  return { ...artistWorkloads };
}

async function getArtistWithLowestWorkload(candidateArtists = null) {
  const workloads = await getArtistWorkloads();
  const pool =
    Array.isArray(candidateArtists) && candidateArtists.length > 0
      ? candidateArtists
      : Object.keys(workloads);

  let selected = null;
  let lowest = Number.POSITIVE_INFINITY;

  pool.forEach((artist) => {
    const normalized = normalizeArtistName(artist);
    if (!normalized) {
      return;
    }
    const workload =
      workloads[normalized] !== undefined
        ? workloads[normalized]
        : Number.POSITIVE_INFINITY;

    if (workload < lowest) {
      lowest = workload;
      selected = normalized;
    }
  });

  if (!selected) {
    selected = "Joan"; // Default fallback
  }

  return selected;
}

/**
 * Select artist with workload balancing
 * Given a list of candidate artists, returns the one with the lowest workload
 */
async function selectArtistWithWorkloadBalancing(candidateArtists) {
  if (!candidateArtists || candidateArtists.length === 0) {
    return null;
  }

  // If only one candidate, return it
  if (candidateArtists.length === 1) {
    return normalizeArtistName(candidateArtists[0]);
  }

  return getArtistWithLowestWorkload(candidateArtists);
}

/**
 * Determine artist for a contact
 * Priority:
 * 1. URL parameter override (?tech=Joan)
 * 2. Contact's artist preference
 * 3. Artist mention in recent conversation (if provided)
 * 4. Style-based routing
 * 5. Workload balancing
 */
async function determineArtist(contact, options = {}) {
  if (!contact) return null;
  const { messageText = null } = options;

  // 1. Check for URL parameter override or explicit preference
  const preferredArtist = getArtistPreferenceFromContact(contact);
  if (preferredArtist) {
    console.log(`✅ Using preferred artist from contact: ${preferredArtist}`);
    return normalizeArtistName(preferredArtist);
  }

  // 2. Artist mention in conversation (SMS/DM)
  if (messageText) {
    const mentionedArtist = detectArtistMention(messageText);
    if (mentionedArtist) {
      console.log(`✅ Detected artist mention in conversation: ${mentionedArtist}`);
      const contactId = contact.id || contact._id;
      if (contactId) {
        try {
          await assignArtistToContact(contactId, mentionedArtist);
        } catch (err) {
          console.error(
            "❌ Failed to persist artist mention:",
            err.message || err
          );
        }
      }
      return mentionedArtist;
    }
  }

  // 3. Style-based routing
  const tattooStyle = getTattooStyleFromContact(contact);
  if (tattooStyle) {
    const candidateArtists = findArtistsForStyle(tattooStyle);
    if (candidateArtists && candidateArtists.length > 0) {
      const selectedArtist = await selectArtistWithWorkloadBalancing(
        candidateArtists
      );
      console.log(`✅ Selected artist based on style "${tattooStyle}": ${selectedArtist}`);
      return selectedArtist;
    }
  }

  // 4. Default fallback (lowest workload)
  const fallbackArtist = await getArtistWithLowestWorkload();
  if (fallbackArtist) {
    console.log(
      `ℹ️ Falling back to lowest-workload artist: ${fallbackArtist} (contact ${
        contact.id || contact._id
      })`
    );
    return fallbackArtist;
  }

  console.warn(
    `⚠️ Could not determine artist for contact ${contact.id || contact._id}`
  );
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
    const normalizedArtist = normalizeArtistName(artistName);

    // Update tattoo field with assigned artist
    await updateTattooFields(contactId, {
      [TATTOO_FIELDS.INQUIRED_TECHNICIAN]: normalizedArtist,
    });

    // Update system fields
    await updateSystemFields(contactId, {
      assigned_artist: normalizedArtist,
      artist_assigned_at: new Date().toISOString(),
    });

    // Update CRM owner
    const assignedUserId = getAssignedUserIdForArtist(normalizedArtist);
    if (assignedUserId) {
      await updateContactAssignedUser(contactId, assignedUserId);
    } else {
      console.warn(
        `⚠️ No assignedUserId found for artist "${normalizedArtist}", owner not updated`
      );
    }

    // Increment in-memory workload cache
    if (artistWorkloads[normalizedArtist] === undefined) {
      artistWorkloads[normalizedArtist] = 0;
    }
    artistWorkloads[normalizedArtist] = (artistWorkloads[normalizedArtist] || 0) + 1;

    console.log(`✅ Assigned artist ${normalizedArtist} to contact ${contactId}`);
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
    const artist = await determineArtist(contact);
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
  const normalized = normalizeArtistName(artistName);
  if (!normalized) return;

  if (artistWorkloads[normalized] === undefined) {
    artistWorkloads[normalized] = 0;
  }

  artistWorkloads[normalized] = Math.max(
    0,
    (artistWorkloads[normalized] || 0) + delta
  );
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
  getAssignedUserIdForArtist,
  getArtistWorkloads,
  getArtistWithLowestWorkload,
  detectArtistMention,
};

