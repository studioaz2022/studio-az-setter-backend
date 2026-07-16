// googleCalendarOAuth.js
// Per-staff Google Calendar OAuth: connection, token storage, and on-demand
// access-token refresh. Each staff member (barber or tattoo artist) connects
// their own personal Google account so their calendar can be two-way synced.
//
// Mirrors the per-barber Square OAuth pattern (src/payments/squareOAuth.js).
// Uses a DEDICATED Web OAuth client (GOOGLE_CALENDAR_OAUTH_*) — deliberately
// separate from the Meet client (GOOGLE_OAUTH_CLIENT_*), whose refresh token
// is bound to its own client. Do not merge the two.
//
// Plan: GOOGLE_CALENDAR_SYNC_PLAN.md (iOS repo root). This module is Phase 1;
// event sync (watch channels, block-slot mirroring) lands in Phase 2 as a
// separate module that consumes getValidAccessToken() from here.

require("dotenv").config({ quiet: true });
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLIENT_ID = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI;

const TATTOO_LOCATION_ID = process.env.GHL_LOCATION_ID;
const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

// calendar.events = read/write events + watch channels on the user's calendars.
// openid email = lets us show which Google account is connected in the app.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
].join(" ");

/** Thrown when the stored refresh token is dead (revoked / expired in Testing
 *  mode). The route layer converts this to a 401 google_reauth_required so the
 *  iOS app can prompt the artist to reconnect — same shape as Square's. */
class GoogleReauthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleReauthRequiredError";
  }
}

/** Resolve an incoming locationId query param to one of our two GHL locations.
 *  Defaults to tattoo when omitted (matches BrandManager's default brand). */
function resolveLocationId(raw) {
  if (raw === BARBER_LOCATION_ID) return BARBER_LOCATION_ID;
  if (raw === TATTOO_LOCATION_ID || !raw) return TATTOO_LOCATION_ID;
  throw new Error(`Unknown locationId: ${raw}`);
}

/** Pack/unpack the OAuth state param: { s: staffGhlId, l: locationId }.
 *  base64url keeps it opaque and URL-safe; no server-side session needed. */
function packState(staffGhlId, locationId) {
  return Buffer.from(JSON.stringify({ s: staffGhlId, l: locationId })).toString(
    "base64url"
  );
}
function unpackState(state) {
  const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  if (!parsed?.s) throw new Error("state missing staffGhlId");
  return { staffGhlId: parsed.s, locationId: resolveLocationId(parsed.l) };
}

/**
 * Build the Google OAuth consent URL for a staff member.
 * access_type=offline + prompt=consent forces Google to issue a refresh token
 * even on reconnects (Google only sends one on the first consent otherwise).
 */
function buildOAuthUrl(staffGhlId, locationId) {
  if (!CLIENT_ID) throw new Error("GOOGLE_CALENDAR_OAUTH_CLIENT_ID not configured");
  if (!REDIRECT_URI) throw new Error("GOOGLE_CALENDAR_OAUTH_REDIRECT_URI not configured");

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: packState(staffGhlId, resolveLocationId(locationId)),
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

/** Decode the email claim out of an id_token JWT (no verification needed —
 *  it came to us directly from Google's token endpoint over TLS). */
function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")
    );
    return payload.email || null;
  } catch {
    return null;
  }
}

/**
 * Exchange the OAuth callback code for tokens and upsert the connection row.
 * Returns { googleEmail } for the deep link back to iOS.
 */
async function exchangeCodeForToken(code, state) {
  if (!CLIENT_SECRET) throw new Error("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET not configured");
  const { staffGhlId, locationId } = unpackState(state);

  const resp = await axios.post(
    TOKEN_URL,
    {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const {
    access_token,
    refresh_token,
    expires_in,
    scope,
    token_type,
    id_token,
  } = resp.data;

  if (!access_token) throw new Error("Google token exchange returned no access_token");

  const googleEmail = id_token ? emailFromIdToken(id_token) : null;
  const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString();

  // Reconnect edge: prompt=consent should always yield a refresh_token, but if
  // Google ever omits it, keep the previously stored one rather than nulling it.
  const existing = await getStaffToken(staffGhlId);

  const { error } = await supabase.from("staff_google_tokens").upsert(
    {
      staff_ghl_user_id: staffGhlId,
      google_email: googleEmail,
      access_token,
      refresh_token: refresh_token || existing?.refresh_token || null,
      token_type: token_type || "Bearer",
      expires_at: expiresAt,
      scope: scope || SCOPES,
      calendar_id: "primary",
      sync_status: "connected",
      last_error: null,
      location_id: locationId,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "staff_ghl_user_id" }
  );
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);

  console.log(
    `[GoogleCalOAuth] Staff ${staffGhlId} connected Google Calendar (${googleEmail || "email unknown"})`
  );
  return { staffGhlId, googleEmail };
}

/** Load a staff member's stored token row (null if not connected). */
async function getStaffToken(staffGhlId) {
  const { data, error } = await supabase
    .from("staff_google_tokens")
    .select("*")
    .eq("staff_ghl_user_id", staffGhlId)
    .single();
  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to load Google token: ${error.message}`);
  }
  return data || null;
}

/**
 * Return a valid access token for a staff member, refreshing lazily if the
 * stored one expires within 60s. Google access tokens live ~1h, so unlike
 * Square there is no cron — every consumer goes through here.
 * Throws GoogleReauthRequiredError if the refresh token is dead.
 */
async function getValidAccessToken(staffGhlId) {
  const row = await getStaffToken(staffGhlId);
  if (!row) throw new GoogleReauthRequiredError(`No Google Calendar connected for staff ${staffGhlId}`);

  const stillValid =
    row.expires_at && new Date(row.expires_at).getTime() - Date.now() > 60_000;
  if (stillValid) return row.access_token;

  if (!row.refresh_token) {
    throw new GoogleReauthRequiredError(`No refresh token stored for staff ${staffGhlId}`);
  }

  try {
    const resp = await axios.post(
      TOKEN_URL,
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: row.refresh_token,
        grant_type: "refresh_token",
      },
      { headers: { "Content-Type": "application/json" } }
    );
    const { access_token, expires_in } = resp.data;

    await supabase
      .from("staff_google_tokens")
      .update({
        access_token,
        expires_at: new Date(Date.now() + (expires_in || 3600) * 1000).toISOString(),
        sync_status: "connected",
        last_error: null,
      })
      .eq("staff_ghl_user_id", staffGhlId);

    return access_token;
  } catch (err) {
    const gErr = err.response?.data?.error;
    if (gErr === "invalid_grant") {
      // Refresh token revoked or expired (7-day Testing-mode expiry hits here).
      await supabase
        .from("staff_google_tokens")
        .update({ sync_status: "error", last_error: "invalid_grant: reconnect required" })
        .eq("staff_ghl_user_id", staffGhlId);
      throw new GoogleReauthRequiredError(
        `Google refresh token invalid for staff ${staffGhlId} — reconnect required`
      );
    }
    throw err;
  }
}

/**
 * Disconnect: best-effort revoke at Google, then delete the token row.
 * Phase 6 adds cleanup of synced block slots / pushed events before the delete.
 */
async function disconnectStaff(staffGhlId) {
  const row = await getStaffToken(staffGhlId);
  if (row) {
    const tokenToRevoke = row.refresh_token || row.access_token;
    try {
      await axios.post(`${REVOKE_URL}?token=${encodeURIComponent(tokenToRevoke)}`);
    } catch (err) {
      // Already-revoked/expired tokens 400 here — safe to ignore.
      console.warn(`[GoogleCalOAuth] Revoke failed (continuing): ${err.message}`);
    }
  }
  const { error } = await supabase
    .from("staff_google_tokens")
    .delete()
    .eq("staff_ghl_user_id", staffGhlId);
  if (error) throw new Error(`Failed to disconnect: ${error.message}`);
  console.log(`[GoogleCalOAuth] Staff ${staffGhlId} disconnected Google Calendar`);
}

/**
 * Phase 0/1 VERIFY helper: list the next few events on the connected calendar.
 * Proves token + refresh + calendar read all work end-to-end. Internal-only —
 * the route wrapping this is gated by x-internal-key because it returns titles.
 */
async function listUpcomingEvents(staffGhlId, maxResults = 5) {
  const accessToken = await getValidAccessToken(staffGhlId);
  const row = await getStaffToken(staffGhlId);
  const calendarId = row?.calendar_id || "primary";

  const resp = await axios.get(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        timeMin: new Date().toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: "startTime",
      },
    }
  );

  return (resp.data?.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    transparency: e.transparency || "opaque",
    status: e.status,
  }));
}

module.exports = {
  buildOAuthUrl,
  exchangeCodeForToken,
  getStaffToken,
  getValidAccessToken,
  disconnectStaff,
  listUpcomingEvents,
  GoogleReauthRequiredError,
};
