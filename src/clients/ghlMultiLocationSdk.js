// ghlMultiLocationSdk.js — Multi-location GHL SDK for staff email verification
// Creates separate SDK instances for tattoo shop and barber shop locations
require("dotenv").config();
const { HighLevel } = require("@gohighlevel/api-client");

const TATTOO_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN;
const BARBER_TOKEN = process.env.GHL_BARBER_SHOP_TOKEN;
const TATTOO_LOCATION_ID = process.env.GHL_LOCATION_ID;
const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

// SDK instances — one per location
const ghlTattoo = TATTOO_TOKEN
  ? new HighLevel({ privateIntegrationToken: TATTOO_TOKEN })
  : null;
const ghlBarber = BARBER_TOKEN
  ? new HighLevel({ privateIntegrationToken: BARBER_TOKEN })
  : null;

if (!ghlTattoo) console.warn("[MultiLocation] Tattoo shop token not set");
if (!ghlBarber) console.warn("[MultiLocation] Barber shop token not set");

// In-memory cache: { users: [], fetchedAt: timestamp }
const cache = {
  tattoo: null,
  barber: null,
};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getUsersForLocation(sdkInstance, locationId) {
  const response = await sdkInstance.users.getUserByLocation({
    locationId,
  });
  return response.users || [];
}

async function getCachedUsers(locationKey, sdkInstance, locationId) {
  const cached = cache[locationKey];
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.users;
  }

  const users = await getUsersForLocation(sdkInstance, locationId);
  cache[locationKey] = { users, fetchedAt: now };
  return users;
}

/**
 * Verify if an email belongs to a GHL staff member across both locations.
 * @param {string} email - Email address to verify
 * @returns {{ found: boolean, ghlUser?: object, locations?: string[] }}
 */
async function verifyStaffEmail(email) {
  const normalizedEmail = email.trim().toLowerCase();
  const results = { tattoo: null, barber: null };

  // Query both locations in parallel
  const promises = [];

  if (ghlTattoo && TATTOO_LOCATION_ID) {
    promises.push(
      getCachedUsers("tattoo", ghlTattoo, TATTOO_LOCATION_ID)
        .then((users) => {
          results.tattoo = users;
        })
        .catch((err) => {
          console.error("[MultiLocation] Tattoo shop user fetch failed:", err.message);
        })
    );
  }

  if (ghlBarber && BARBER_LOCATION_ID) {
    promises.push(
      getCachedUsers("barber", ghlBarber, BARBER_LOCATION_ID)
        .then((users) => {
          results.barber = users;
        })
        .catch((err) => {
          console.error("[MultiLocation] Barber shop user fetch failed:", err.message);
        })
    );
  }

  await Promise.all(promises);

  // Search for email match in each location
  const locations = [];
  let matchedUser = null;

  if (results.tattoo) {
    const match = results.tattoo.find(
      (u) => u.email && u.email.trim().toLowerCase() === normalizedEmail && !u.deleted
    );
    if (match) {
      locations.push("tattoo_shop");
      matchedUser = match;
    }
  }

  if (results.barber) {
    const match = results.barber.find(
      (u) => u.email && u.email.trim().toLowerCase() === normalizedEmail && !u.deleted
    );
    if (match) {
      locations.push("barber_shop");
      if (!matchedUser) matchedUser = match;
    }
  }

  if (!matchedUser) {
    return { found: false };
  }

  return {
    found: true,
    ghlUser: {
      id: matchedUser.id,
      name: matchedUser.name || `${matchedUser.firstName || ""} ${matchedUser.lastName || ""}`.trim(),
      firstName: matchedUser.firstName,
      lastName: matchedUser.lastName,
      email: matchedUser.email,
    },
    locations,
  };
}

module.exports = { verifyStaffEmail };
