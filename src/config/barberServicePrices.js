// barberServicePrices.js
// Loads calendar_id → service_price from Supabase barber_service_prices table.
// Caches in memory with a 5-minute TTL.

const { supabase } = require("../clients/supabaseClient");

let priceCache = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load the full price map from Supabase (with caching).
 * @returns {Promise<Map<string, number>>} calendarId → price
 */
async function getServicePriceMap() {
  const now = Date.now();
  if (priceCache && now < cacheExpiry) {
    return priceCache;
  }

  if (!supabase) {
    console.warn("[ServicePrices] Supabase not configured, returning empty map");
    return new Map();
  }

  const { data, error } = await supabase
    .from("barber_service_prices")
    .select("calendar_id, price");

  if (error) {
    console.error("[ServicePrices] Failed to load prices:", error.message);
    // Return stale cache if available, otherwise empty
    return priceCache || new Map();
  }

  const map = new Map();
  for (const row of data || []) {
    map.set(row.calendar_id, parseFloat(row.price));
  }

  priceCache = map;
  cacheExpiry = now + CACHE_TTL_MS;
  console.log(`[ServicePrices] Loaded ${map.size} service prices`);
  return map;
}

/**
 * Look up the service price for a given calendar ID.
 * @param {string} calendarId
 * @returns {Promise<number|null>} price in dollars, or null if not found
 */
async function lookupServicePrice(calendarId) {
  if (!calendarId) return null;
  const map = await getServicePriceMap();
  return map.get(calendarId) || null;
}

module.exports = { getServicePriceMap, lookupServicePrice };
