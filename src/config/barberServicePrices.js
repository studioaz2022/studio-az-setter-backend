// barberServicePrices.js
// Loads calendar_id → service_price and deposit_percentage from Supabase.
// Caches in memory with a 5-minute TTL.

const { supabase } = require("../clients/supabaseClient");

let priceCache = null;
let depositCache = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load all service price data from Supabase (with caching).
 * Populates both priceCache and depositCache.
 */
async function loadCaches() {
  const now = Date.now();
  if (priceCache && depositCache && now < cacheExpiry) return;

  if (!supabase) {
    console.warn("[ServicePrices] Supabase not configured, returning empty maps");
    priceCache = priceCache || new Map();
    depositCache = depositCache || new Map();
    return;
  }

  const { data, error } = await supabase
    .from("barber_service_prices")
    .select("calendar_id, price, deposit_percentage");

  if (error) {
    console.error("[ServicePrices] Failed to load prices:", error.message);
    priceCache = priceCache || new Map();
    depositCache = depositCache || new Map();
    return;
  }

  const prices = new Map();
  const deposits = new Map();
  for (const row of data || []) {
    prices.set(row.calendar_id, parseFloat(row.price));
    if (row.deposit_percentage != null) {
      deposits.set(row.calendar_id, row.deposit_percentage);
    }
  }

  priceCache = prices;
  depositCache = deposits;
  cacheExpiry = now + CACHE_TTL_MS;
  console.log(`[ServicePrices] Loaded ${prices.size} prices, ${deposits.size} deposit calendars`);
}

/**
 * Load the full price map from Supabase (with caching).
 * @returns {Promise<Map<string, number>>} calendarId → price
 */
async function getServicePriceMap() {
  await loadCaches();
  return priceCache;
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

/**
 * Look up the deposit percentage for a given calendar ID.
 * @param {string} calendarId
 * @returns {Promise<number|null>} deposit percentage (e.g. 50), or null if no deposit required
 */
async function lookupDepositPercentage(calendarId) {
  if (!calendarId) return null;
  await loadCaches();
  return depositCache.get(calendarId) || null;
}

module.exports = { getServicePriceMap, lookupServicePrice, lookupDepositPercentage };
