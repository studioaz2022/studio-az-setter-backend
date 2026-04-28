// fillTokenService.js
// Token plumbing for the "Fill Flow" — pre-loaded consultation page driven by an
// auto-confirmation SMS link. See FILL_FLOW_PLAN.md (Phases 1 + 4.5) for context.
//
// Token lifecycle:
//   createToken           — called immediately after a landing-page inquiry is processed
//   resolveToken          — public GET on the fill page; returns prefill payload + bumps last_seen_at
//   recordStepProgress    — public POST on each step transition; bumps first/last_step_completed_at
//   consumeToken          — public POST on final submission; locks the token + returns ok
//
// All public reads/writes treat token validity uniformly:
//   - missing       → 404
//   - expired       → 410
//   - already used  → 410
// The HTTP layer (app.js) maps these via the `code` field on the thrown error.
//
// Token format: 12-char base32 lowercase. ~60 bits of entropy — plenty for a
// 14-day per-contact link, and short enough to fit in an SMS without a shortener
// (`fill.studioaztattoo.com/abc23xyz98qj` ≈ 44 chars total).

const crypto = require("crypto");
const { supabase } = require("../clients/supabaseClient");
const { getContact } = require("../clients/ghlClient");

const DEFAULT_EXPIRY_DAYS = 14;
const TOKEN_LENGTH = 12;

// Base32 lowercase, no ambiguous chars (no 0/o/1/l)
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const FILL_BASE_URL =
  process.env.FILL_BASE_URL || "https://fill.studioaztattoo.com";

// GHL custom field IDs we read for prefill (mirrored from src/clients/ghlClient.js
// CUSTOM_FIELD_MAP — kept in sync intentionally; the source of truth is GHL).
const FIELD_IDS = {
  language_preference: "ETxasC6QlyxRaKU18kbz",
  landing_page_inquiry: "kNJrZsTQhDmILbdqJlo0",
  tattoo_ideasreferences: process.env.GHL_TATTOO_FILE_FIELD_ID || null,
};

class FillTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 404 | 410 | 500
    this.name = "FillTokenError";
  }
}

function ensureSupabase() {
  if (!supabase) {
    throw new FillTokenError(500, "Supabase client not configured");
  }
}

function generateToken() {
  // crypto.randomBytes for unbiased uniform sampling across the alphabet.
  const buf = crypto.randomBytes(TOKEN_LENGTH);
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    out += TOKEN_ALPHABET[buf[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

/**
 * Create a fill token for a freshly-processed inquiry.
 *
 * Idempotency: if an active (non-submitted, non-expired) token already exists for
 * this contact, we return it instead of minting a new one. This protects against
 * the "lead submits the inquiry twice in a row" case — same SMS link works.
 *
 * Collision handling: 30^12 = ~5.3e17 possibilities, so collisions are
 * astronomically rare. We retry up to 5 times on PK conflict just in case.
 *
 * @param {object} args
 * @param {string} args.contactId    — GHL contact ID
 * @param {string} args.artistSlug   — joan | andrew | …
 * @param {string} [args.language]   — 'en' | 'es' (defaults to 'en')
 * @param {string} [args.source]     — instagram | tiktok | bio_link
 * @param {number} [args.expiryDays] — default 14
 * @returns {Promise<{ token: string, url: string, expiresAt: string, reused: boolean }>}
 */
async function createToken({
  contactId,
  artistSlug,
  language = "en",
  source = null,
  expiryDays = DEFAULT_EXPIRY_DAYS,
}) {
  ensureSupabase();

  if (!contactId || !artistSlug) {
    throw new FillTokenError(500, "createToken requires contactId + artistSlug");
  }

  // 1. Look for an active reusable token first.
  const nowIso = new Date().toISOString();
  const { data: existing, error: existingErr } = await supabase
    .from("fill_tokens")
    .select("token, expires_at")
    .eq("contact_id", contactId)
    .is("submitted_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingErr) {
    console.error("[fillToken] Lookup-existing failed:", existingErr.message);
    // Fall through — we'd rather mint a new one than fail the inquiry.
  } else if (existing?.token) {
    return {
      token: existing.token,
      url: `${FILL_BASE_URL}/${existing.token}`,
      expiresAt: existing.expires_at,
      reused: true,
    };
  }

  // 2. Mint a new token, with collision retry.
  const expiresAt = new Date(
    Date.now() + expiryDays * 24 * 60 * 60 * 1000
  ).toISOString();

  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateToken();
    const { error: insertErr } = await supabase.from("fill_tokens").insert({
      token,
      contact_id: contactId,
      artist_slug: artistSlug,
      language,
      source,
      expires_at: expiresAt,
    });

    if (!insertErr) {
      return {
        token,
        url: `${FILL_BASE_URL}/${token}`,
        expiresAt,
        reused: false,
      };
    }

    // PK collision → retry. Anything else → fail loud.
    const msg = insertErr.message || "";
    const isCollision =
      msg.includes("duplicate key") ||
      msg.includes("unique") ||
      insertErr.code === "23505";
    if (!isCollision) {
      console.error("[fillToken] Insert failed:", insertErr);
      throw new FillTokenError(500, `Token insert failed: ${msg}`);
    }
  }

  throw new FillTokenError(500, "Failed to mint unique fill token after 5 attempts");
}

/**
 * Internal: load + validate a token row. Throws FillTokenError(404 | 410).
 * Does NOT touch any timestamps — callers decide whether to bump last_seen_at etc.
 */
async function loadValidToken(token) {
  ensureSupabase();

  if (!token || typeof token !== "string") {
    throw new FillTokenError(404, "Token not found");
  }

  const { data, error } = await supabase
    .from("fill_tokens")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    console.error("[fillToken] loadValidToken query failed:", error.message);
    throw new FillTokenError(500, "Token lookup failed");
  }

  if (!data) {
    throw new FillTokenError(404, "Token not found");
  }

  if (data.submitted_at) {
    throw new FillTokenError(410, "Fill form already submitted");
  }

  if (new Date(data.expires_at) < new Date()) {
    throw new FillTokenError(410, "Fill link expired");
  }

  return data;
}

/**
 * Public: resolve a token and return the prefill payload for the fill page.
 *
 * Side effect: updates `last_seen_at = now()` so analytics can distinguish
 * "clicked but didn't submit" from "never clicked." Failures here are non-fatal —
 * we still return the prefill payload.
 *
 * @param {string} token
 * @returns {Promise<{
 *   token: string,
 *   contactId: string,
 *   artistSlug: string,
 *   language: 'en'|'es',
 *   source: string|null,
 *   expiresAt: string,
 *   firstName: string|null,
 *   lastName: string|null,
 *   phone: string|null,
 *   message: string|null,
 *   photos: string[],
 * }>}
 */
async function resolveToken(token) {
  const row = await loadValidToken(token);

  // Bump last_seen_at — fire-and-await but tolerate failure.
  try {
    await supabase
      .from("fill_tokens")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("token", token);
  } catch (err) {
    console.warn("[fillToken] last_seen_at bump failed:", err.message);
  }

  // Pull contact prefill from GHL.
  const contact = await getContact(row.contact_id);

  // Even if the contact lookup failed, we can still serve the page with what
  // we have on the token row — better degraded than dead.
  const cf = contact?.customField || {};

  // Landing page inquiry is stored as `[source]message` — strip the prefix for display.
  let messageText = null;
  const inquiryRaw = cf[FIELD_IDS.landing_page_inquiry] || null;
  if (inquiryRaw) {
    const stripped = inquiryRaw.replace(/^\[[^\]]+\]/, "");
    messageText = stripped || inquiryRaw;
  }

  // Photos are stored as a JSON array of URLs by uploadFilesToTattooCustomField.
  let photos = [];
  if (FIELD_IDS.tattoo_ideasreferences) {
    const photosRaw = cf[FIELD_IDS.tattoo_ideasreferences];
    if (Array.isArray(photosRaw)) {
      photos = photosRaw.filter((u) => typeof u === "string" && u.length > 0);
    } else if (typeof photosRaw === "string" && photosRaw.length > 0) {
      // Some GHL responses return a comma-separated string.
      photos = photosRaw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  return {
    token: row.token,
    contactId: row.contact_id,
    artistSlug: row.artist_slug,
    language: row.language || "en",
    source: row.source,
    expiresAt: row.expires_at,
    firstName: contact?.firstName || contact?.firstNameLowerCase || null,
    lastName: contact?.lastName || contact?.lastNameLowerCase || null,
    phone: contact?.phone || null,
    message: messageText,
    photos,
  };
}

/**
 * Public: record a step transition for funnel analytics.
 *
 * - Always bumps `last_step_completed_at`.
 * - On the very first step transition (1 → 2 etc.), also sets `first_step_completed_at`.
 * - Idempotent: re-firing the same step is fine.
 *
 * `step` is the index of the step the user just completed (1-indexed). The exact
 * value is not stored — we only need timestamps for the rollup snapshot.
 *
 * @param {string} token
 * @param {number} step
 * @returns {Promise<{ ok: true }>}
 */
async function recordStepProgress(token, step) {
  const row = await loadValidToken(token);

  const stepNum = Number.isFinite(step) ? Math.floor(step) : null;
  if (stepNum === null || stepNum < 1) {
    throw new FillTokenError(500, "step must be a positive integer");
  }

  const nowIso = new Date().toISOString();
  const update = { last_step_completed_at: nowIso };
  if (!row.first_step_completed_at) {
    update.first_step_completed_at = nowIso;
  }

  const { error } = await supabase
    .from("fill_tokens")
    .update(update)
    .eq("token", token);

  if (error) {
    console.error("[fillToken] recordStepProgress update failed:", error.message);
    throw new FillTokenError(500, "Failed to record step progress");
  }

  return { ok: true };
}

/**
 * Public: lock the token as submitted. The HTTP handler is responsible for
 * actually applying the form payload to GHL — this function only updates the
 * token row.
 *
 * Race protection: uses a conditional update (submitted_at IS NULL) so a second
 * concurrent submit returns "already submitted" instead of double-firing the
 * downstream side-effects.
 *
 * @param {string} token
 * @returns {Promise<{ contactId: string, artistSlug: string, language: string, source: string|null }>}
 */
async function consumeToken(token) {
  const row = await loadValidToken(token);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("fill_tokens")
    .update({
      submitted_at: nowIso,
      last_step_completed_at: nowIso,
      first_step_completed_at: row.first_step_completed_at || nowIso,
    })
    .eq("token", token)
    .is("submitted_at", null)
    .select("token")
    .maybeSingle();

  if (error) {
    console.error("[fillToken] consumeToken update failed:", error.message);
    throw new FillTokenError(500, "Failed to mark token submitted");
  }

  if (!data) {
    // Lost the race — another request submitted it first.
    throw new FillTokenError(410, "Fill form already submitted");
  }

  return {
    contactId: row.contact_id,
    artistSlug: row.artist_slug,
    language: row.language || "en",
    source: row.source,
  };
}

module.exports = {
  createToken,
  resolveToken,
  recordStepProgress,
  consumeToken,
  FillTokenError,
  // Exported for tests
  _generateToken: generateToken,
  FILL_BASE_URL,
};
