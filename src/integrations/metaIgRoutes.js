/**
 * Meta / Instagram proxy endpoints for the barbershop website.
 *
 * The frontend (barbershop-website) never touches the IG access token
 * directly. It hits these endpoints, which read the current token from
 * Supabase table `integration_tokens` (auto-refreshed by
 * src/services/metaTokenRefresh.js) and proxy the Graph API call.
 *
 * Why proxy instead of just handing the token to Vercel:
 *   - Token never leaves the backend — no chance of client-side leaks
 *   - Token rotation is atomic + transparent to the frontend
 *   - Backend can log every fetch for observability
 *   - Backend can enforce simple in-memory cache to reduce Graph rate use
 *
 * Endpoints:
 *   GET /api/integrations/meta/ig-posts?provider=<slug>&limit=<n>&fetchLimit=<n>
 *   GET /api/integrations/meta/ig-profile?provider=<slug>
 *
 * `provider` defaults to "meta_ig_barbershop". Future-proof for
 * multi-account (Lionel's personal brand, artist accounts, etc.)
 */

const { createClient } = require("@supabase/supabase-js");

// ── Config ────────────────────────────────────────────────────────
const DEFAULT_PROVIDER = "meta_ig_barbershop";
const POST_FIELDS =
  "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
const PROFILE_FIELDS =
  "username,name,biography,profile_picture_url,followers_count,media_count";
const GRAPH_BASE = "https://graph.instagram.com/v25.0";

// Simple in-memory cache — 30 min TTL per (provider, kind, key).
// This is a per-instance cache; on Render's single-instance web service
// it's a real cache. On a fleet it'd be per-instance which is fine —
// we're just being nice to the Graph API.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}
function cacheSet(key, value) {
  cache.set(key, { storedAt: Date.now(), value });
}

// ── Supabase (lazy) ───────────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  _supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  return _supabase;
}

/**
 * Load { accessToken, businessAccountId } from Supabase for a provider.
 * Returns null if the row is missing or the token/id fields are empty.
 */
async function loadCreds(provider) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("integration_tokens")
    .select("access_token, metadata")
    .eq("provider", provider)
    .maybeSingle();
  if (error) {
    console.error(
      `[metaIgRoutes] failed to load creds for ${provider}:`,
      error.message
    );
    return null;
  }
  if (!data || !data.access_token) return null;
  const bizId = data.metadata?.ig_business_account_id;
  if (!bizId) return null;
  return { accessToken: data.access_token, businessAccountId: bizId };
}

// ── Barbershop-post filter (mirrors the frontend logic that used to
//    live in barbershop-website/lib/instagram.ts) ──────────────────
const BARBER_HASHTAGS = [
  "#barber",
  "#minneapolisbarber",
  "#minneapolisbarbershop",
  "#minnesotabarbershop",
  "#mnbarber",
  "#mnbarbers",
  "#minnesotabarber",
  "#minneapolishair",
  "#mnhairstylist",
];
const TATTOO_DISQUALIFIERS = ["tattoo"];

function isBarbershopPost(caption) {
  if (!caption) return false;
  const lower = caption.toLowerCase();
  if (TATTOO_DISQUALIFIERS.some((w) => lower.includes(w))) return false;
  return BARBER_HASHTAGS.some((t) => lower.includes(t));
}

// ── Route handlers ────────────────────────────────────────────────

async function handleIgPosts(req, res) {
  const provider = req.query.provider || DEFAULT_PROVIDER;
  const limit = Math.min(parseInt(req.query.limit || "3", 10), 20);
  const fetchLimit = Math.min(
    parseInt(req.query.fetchLimit || "30", 10),
    100
  );
  const filter = req.query.filter !== "false"; // default true for barbershop

  const cacheKey = `posts:${provider}:${limit}:${fetchLimit}:${filter}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const creds = await loadCreds(provider);
  if (!creds) return res.json({ data: [] });

  try {
    const url = `${GRAPH_BASE}/${creds.businessAccountId}/media` +
      `?fields=${POST_FIELDS}&limit=${fetchLimit}` +
      `&access_token=${encodeURIComponent(creds.accessToken)}`;
    const r = await fetch(url);
    const body = await r.json();
    if (!r.ok || body.error) {
      console.error(
        `[metaIgRoutes] posts fetch failed for ${provider}:`,
        body.error?.message || `HTTP ${r.status}`
      );
      return res.json({ data: [] });
    }
    const all = body.data || [];
    const filtered = filter ? all.filter((p) => isBarbershopPost(p.caption)) : all;
    const result = { data: filtered.slice(0, limit) };
    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error(
      `[metaIgRoutes] posts fetch threw for ${provider}:`,
      err.message || err
    );
    return res.json({ data: [] });
  }
}

async function handleIgProfile(req, res) {
  const provider = req.query.provider || DEFAULT_PROVIDER;

  const cacheKey = `profile:${provider}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const creds = await loadCreds(provider);
  if (!creds) return res.json({ profile: null });

  try {
    const url = `${GRAPH_BASE}/${creds.businessAccountId}` +
      `?fields=${PROFILE_FIELDS}` +
      `&access_token=${encodeURIComponent(creds.accessToken)}`;
    const r = await fetch(url);
    const body = await r.json();
    if (!r.ok || body.error) {
      console.error(
        `[metaIgRoutes] profile fetch failed for ${provider}:`,
        body.error?.message || `HTTP ${r.status}`
      );
      return res.json({ profile: null });
    }
    const result = { profile: body };
    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error(
      `[metaIgRoutes] profile fetch threw for ${provider}:`,
      err.message || err
    );
    return res.json({ profile: null });
  }
}

function registerMetaIgRoutes(app) {
  app.get("/api/integrations/meta/ig-posts", handleIgPosts);
  app.get("/api/integrations/meta/ig-profile", handleIgProfile);
  console.log(
    "[metaIgRoutes] registered /api/integrations/meta/ig-posts + /ig-profile"
  );
}

module.exports = { registerMetaIgRoutes };
