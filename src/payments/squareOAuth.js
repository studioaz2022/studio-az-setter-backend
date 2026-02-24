// squareOAuth.js
// Handles per-barber Square OAuth connection, token storage, and token refresh.
// Each barber connects their own personal Square account so we can
// pull their transactions independently.

const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const IS_PROD = process.env.SQUARE_ENVIRONMENT === "production";

const APP_ID = IS_PROD
  ? process.env.SQUARE_APPLICATION_ID
  : process.env.SQUARE_SANDBOX_APPLICATION_ID;

const APP_SECRET = IS_PROD
  ? process.env.SQUARE_APPLICATION_SECRET
  : process.env.SQUARE_SANDBOX_APPLICATION_SECRET;

const SQUARE_BASE_URL = IS_PROD
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";

const OAUTH_REDIRECT_URI = process.env.SQUARE_OAUTH_REDIRECT_URI;

// GHL barber shop location ID — all barber tokens are scoped to this location
const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

/**
 * Build the Square OAuth authorization URL for a barber.
 * The barberGhlId is passed as `state` so we can identify the barber
 * in the callback without storing session state server-side.
 *
 * Scopes requested:
 *   PAYMENTS_READ       — list payments/transactions
 *   CUSTOMERS_READ      — read customer email/phone for contact matching
 */
function buildOAuthUrl(barberGhlId) {
  if (!APP_ID) throw new Error("Square Application ID not configured");
  if (!OAUTH_REDIRECT_URI) throw new Error("SQUARE_OAUTH_REDIRECT_URI not configured");

  const scopes = [
    "PAYMENTS_READ",
    "CUSTOMERS_READ",
  ].join("+");

  const state = encodeURIComponent(barberGhlId);

  // session=false is required for production; omit in sandbox (defaults to true)
  const sessionParam = IS_PROD ? "&session=false" : "";

  return (
    `${SQUARE_BASE_URL}/oauth2/authorize` +
    `?client_id=${APP_ID}` +
    `&scope=${scopes}` +
    sessionParam +
    `&state=${state}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}`
  );
}

/**
 * Exchange a temporary auth code (from OAuth callback) for an access token.
 * Stores the token in Supabase keyed by barberGhlId.
 */
async function exchangeCodeForToken(code, barberGhlId) {
  if (!APP_SECRET) throw new Error("Square Application Secret not configured");

  const response = await axios.post(
    `${SQUARE_BASE_URL}/oauth2/token`,
    {
      client_id: APP_ID,
      client_secret: APP_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: OAUTH_REDIRECT_URI,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const {
    access_token,
    refresh_token,
    token_type,
    expires_at,
    merchant_id,
  } = response.data;

  // Fetch merchant name + primary location ID from Square (best-effort, non-fatal)
  const merchantName = await fetchMerchantName(access_token, merchant_id) || merchant_id;
  const squareLocationId = await fetchPrimaryLocationId(access_token);

  // Upsert into Supabase (insert or update if barber reconnects)
  const { error } = await supabase.from("barber_square_tokens").upsert(
    {
      barber_ghl_id: barberGhlId,
      square_merchant_id: merchant_id,
      square_merchant_name: merchantName,
      access_token,
      refresh_token: refresh_token || null,
      token_type: token_type || "bearer",
      expires_at: expires_at || null,
      square_location_id: squareLocationId,
      location_id: BARBER_LOCATION_ID,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "barber_ghl_id" }
  );

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);

  console.log(`[SquareOAuth] Barber ${barberGhlId} connected Square merchant ${merchant_id} (${merchantName})`);

  return { merchantId: merchant_id, merchantName, squareLocationId };
}

/**
 * Fetch merchant display name from Square /v2/merchants/{merchantId}
 */
async function fetchMerchantName(accessToken, merchantId) {
  try {
    const res = await axios.get(`${SQUARE_BASE_URL}/v2/merchants/${merchantId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.data?.merchant?.business_name || null;
  } catch {
    return null;
  }
}

/**
 * Fetch the barber's primary Square location ID.
 * Most booth-renter accounts have exactly one location.
 */
async function fetchPrimaryLocationId(accessToken) {
  try {
    const res = await axios.get(`${SQUARE_BASE_URL}/v2/locations`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const locations = res.data?.locations || [];
    // Prefer the first active location
    const active = locations.find((l) => l.status === "ACTIVE") || locations[0];
    return active?.id || null;
  } catch {
    return null;
  }
}

/**
 * Load a barber's stored token row from Supabase.
 */
async function getBarberToken(barberGhlId) {
  const { data, error } = await supabase
    .from("barber_square_tokens")
    .select("*")
    .eq("barber_ghl_id", barberGhlId)
    .single();

  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to load barber token: ${error.message}`);
  }
  return data || null;
}

/**
 * Disconnect a barber's Square account (delete token row).
 */
async function disconnectBarber(barberGhlId) {
  const { error } = await supabase
    .from("barber_square_tokens")
    .delete()
    .eq("barber_ghl_id", barberGhlId);

  if (error) throw new Error(`Failed to disconnect barber: ${error.message}`);
  console.log(`[SquareOAuth] Barber ${barberGhlId} disconnected Square`);
}

/**
 * Get connection status for all barbers at the barber shop location.
 * Returns array of { barberGhlId, isConnected, merchantName, lastSyncedAt }
 */
async function getAllBarberConnectionStatuses() {
  const { data, error } = await supabase
    .from("barber_square_tokens")
    .select("barber_ghl_id, square_merchant_name, last_synced_at, connected_at")
    .eq("location_id", BARBER_LOCATION_ID);

  if (error) throw new Error(`Failed to list barber tokens: ${error.message}`);
  return data || [];
}

/**
 * Refresh a barber's Square access token using their stored refresh token.
 * Square docs recommend refreshing every 7 days or less (access tokens expire in 30 days).
 * Returns the new token data.
 */
async function refreshBarberToken(barberGhlId) {
  if (!APP_SECRET) throw new Error("Square Application Secret not configured");

  const tokenRow = await getBarberToken(barberGhlId);
  if (!tokenRow) throw new Error(`No Square account connected for barber ${barberGhlId}`);
  if (!tokenRow.refresh_token) throw new Error(`No refresh token stored for barber ${barberGhlId}`);

  const response = await axios.post(
    `${SQUARE_BASE_URL}/oauth2/token`,
    {
      client_id: APP_ID,
      client_secret: APP_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokenRow.refresh_token,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const { access_token, refresh_token, expires_at } = response.data;

  const { error } = await supabase
    .from("barber_square_tokens")
    .update({
      access_token,
      refresh_token: refresh_token || tokenRow.refresh_token, // keep old if not rotated
      expires_at: expires_at || null,
    })
    .eq("barber_ghl_id", barberGhlId);

  if (error) throw new Error(`Failed to update refreshed token: ${error.message}`);

  console.log(`[SquareOAuth] Refreshed token for barber ${barberGhlId}, expires ${expires_at}`);
  return { access_token, expires_at };
}

/**
 * Refresh tokens for all barbers whose access token expires within 8 days.
 * Call this from a daily cron job to stay within Square's 7-day refresh recommendation.
 */
async function refreshAllExpiringTokens() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 8); // refresh anything expiring within 8 days

  const { data: rows, error } = await supabase
    .from("barber_square_tokens")
    .select("barber_ghl_id, expires_at")
    .eq("location_id", BARBER_LOCATION_ID);

  if (error) throw new Error(`Failed to list tokens for refresh: ${error.message}`);

  const results = { refreshed: 0, failed: 0, errors: [] };

  for (const row of rows || []) {
    // Refresh if expiring soon OR if expires_at is unknown (be safe)
    const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
    if (!expiresAt || expiresAt <= cutoff) {
      try {
        await refreshBarberToken(row.barber_ghl_id);
        results.refreshed++;
      } catch (err) {
        console.error(`[SquareOAuth] Failed to refresh token for ${row.barber_ghl_id}:`, err.message);
        results.failed++;
        results.errors.push({ barberGhlId: row.barber_ghl_id, error: err.message });
      }
    }
  }

  console.log(`[SquareOAuth] Token refresh run: ${results.refreshed} refreshed, ${results.failed} failed`);
  return results;
}

module.exports = {
  buildOAuthUrl,
  exchangeCodeForToken,
  getBarberToken,
  disconnectBarber,
  getAllBarberConnectionStatuses,
  refreshBarberToken,
  refreshAllExpiringTokens,
};
