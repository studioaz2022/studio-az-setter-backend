// gbpPhotoPipeline.js
// Weekly drip of fresh gallery photos onto both Google Business Profiles.
// Spec: GBP_PHOTO_PIPELINE_PLAN.md (iOS repo root). Recent photos measurably
// help local rank in visual industries (Sterling Sky 2025) — freshness is the
// signal, so a small weekly drip beats bulk-uploading the backlog.
//
// Constraints the code alone doesn't show:
//  - Ledger rows are claimed BEFORE the push (fail-closed): double-posting to
//    the public profile is the failure mode we guard against, not a missed
//    week. A 'claimed' row that never became 'pushed' shows up in status()
//    and is deliberately never retried without a human look.
//  - The v4 media endpoint is legacy (the Q&A API sunset is the precedent):
//    every Google error is caught per-photo and recorded so a sunset shows up
//    as visible 'failed' rows, never as a crashed run.

const axios = require("axios");
const sharp = require("sharp");
const { createClient } = require("@supabase/supabase-js");
const { supabase } = require("../clients/supabaseClient");
const { getAccessToken } = require("./gbpClient");

const V4_URL = "https://mybusiness.googleapis.com/v4";
const ACCOUNT = "accounts/107017428683340496769";
const WEEKLY_CAP = 3; // per profile per run
const MIN_DIM = 250; // Google's minimum photo dimension
const CANDIDATE_POOL = 120; // newest N published photos considered per source

const GALLERY_URL = process.env.GALLERY_SUPABASE_URL;
const GALLERY_SECRET = process.env.GALLERY_SUPABASE_SECRET_KEY;
const gallery =
  GALLERY_URL && GALLERY_SECRET
    ? createClient(GALLERY_URL, GALLERY_SECRET, { auth: { persistSession: false } })
    : null;

// groupKey drives the round-robin: style for tattoo (reinforces the service
// listings), barber for the shop (every chair gets representation).
const SOURCES = {
  tattoo: {
    gbpLocation: "locations/13377765707428643781",
    async candidates() {
      if (!supabase) throw new Error("main Supabase not configured");
      const { data, error } = await supabase
        .from("tattoo_portfolio_photos")
        .select("id, style, url, width, height, created_at, tattoo_artists!inner(active)")
        .eq("status", "published")
        .eq("tattoo_artists.active", true)
        .order("created_at", { ascending: false })
        .limit(CANDIDATE_POOL);
      if (error) throw new Error(`tattoo candidates: ${error.message}`);
      return (data || []).map((r) => ({
        photoId: String(r.id),
        url: r.url,
        groupKey: r.style || "unstyled",
        width: r.width,
        height: r.height,
      }));
    },
  },
  barber: {
    gbpLocation: "locations/3193954697909267343",
    async candidates() {
      if (!gallery) throw new Error("barber-gallery Supabase not configured");
      const { data, error } = await gallery
        .from("gallery_photos")
        .select("id, barber_id, cut_pillar, url, width, height, created_at")
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(CANDIDATE_POOL);
      if (error) throw new Error(`barber candidates: ${error.message}`);
      return (data || []).map((r) => ({
        photoId: String(r.id),
        url: r.url,
        groupKey: String(r.barber_id || "unknown"),
        width: r.width,
        height: r.height,
      }));
    },
  },
};

// Missing dimensions = rows that predate dimension capture; those uploads went
// through the croppers, which never emit anything near this small.
function bigEnough(c) {
  return (c.width == null || c.width >= MIN_DIM) && (c.height == null || c.height >= MIN_DIM);
}

// One photo per group in rotation, newest-first within each group, until cap.
function roundRobin(candidates, cap) {
  const groups = new Map();
  for (const c of candidates) {
    if (!groups.has(c.groupKey)) groups.set(c.groupKey, []);
    groups.get(c.groupKey).push(c);
  }
  const queues = [...groups.values()];
  const picked = [];
  for (let i = 0; picked.length < cap; i++) {
    const queue = queues[i % queues.length];
    const next = queue.shift();
    if (next) picked.push(next);
    if (queues.every((q) => q.length === 0) && !next) break;
    if (i > candidates.length + queues.length) break;
  }
  return picked;
}

async function pushedIds(source, ids) {
  if (!ids.length) return new Set();
  const { data, error } = await supabase
    .from("gbp_photo_pushes")
    .select("source_photo_id")
    .eq("source", source)
    .in("source_photo_id", ids);
  if (error) throw new Error(`ledger read: ${error.message}`);
  return new Set((data || []).map((r) => r.source_photo_id));
}

async function selectForSource(source) {
  const cfg = SOURCES[source];
  const all = (await cfg.candidates()).filter(bigEnough).filter((c) => c.url);
  const seen = await pushedIds(source, all.map((c) => c.photoId));
  return roundRobin(all.filter((c) => !seen.has(c.photoId)), WEEKLY_CAP);
}

// Both galleries serve WEBP, which Google rejects ("Image format is not
// supported"), so the CDN URL can't be the sourceUrl. The v4 dataRef byte-
// upload flow is broken too (bytes POST returns 200, media create then 500s
// INTERNAL on every retry — legacy-API decay). What works: sourceUrl pointing
// at our own public JPEG converter route (/api/seo/gbp-photos/img/...), which
// streams the gallery photo re-encoded as JPEG. Category must be ADDITIONAL —
// AT_WORK is rejected on the tattoo location. All learned live 2026-09-14.
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "https://studio-az-setter-backend.onrender.com";

function converterUrl(source, photoId) {
  return `${PUBLIC_BASE}/api/seo/gbp-photos/img/${source}/${photoId}.jpg`;
}

async function pushOne(token, gbpLocation, source, photoId) {
  const resp = await axios.post(
    `${V4_URL}/${ACCOUNT}/${gbpLocation}/media`,
    {
      mediaFormat: "PHOTO",
      locationAssociation: { category: "ADDITIONAL" },
      sourceUrl: converterUrl(source, photoId),
    },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 60000 }
  );
  return resp.data?.name || null;
}

/**
 * Resolve a gallery photo id to its CDN URL — only for published photos, so
 * the public converter route can't be used to proxy arbitrary URLs.
 */
async function resolvePublishedUrl(source, photoId) {
  if (source === "tattoo") {
    if (!supabase) return null;
    const { data } = await supabase
      .from("tattoo_portfolio_photos")
      .select("url")
      .eq("id", photoId)
      .eq("status", "published")
      .maybeSingle();
    return data?.url || null;
  }
  if (source === "barber") {
    if (!gallery) return null;
    const { data } = await gallery
      .from("gallery_photos")
      .select("url")
      .eq("id", photoId)
      .eq("status", "published")
      .maybeSingle();
    return data?.url || null;
  }
  return null;
}

/** Fetch a published photo and return it re-encoded as a JPEG buffer. */
async function jpegForPhoto(source, photoId) {
  const url = await resolvePublishedUrl(source, photoId);
  if (!url) return null;
  const img = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  return sharp(Buffer.from(img.data)).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Run one drip cycle across both profiles.
 * dryRun returns the selection without touching the ledger or Google.
 */
async function runCycle({ dryRun = false } = {}) {
  const results = {};
  const token = dryRun ? null : await getAccessToken();

  for (const source of Object.keys(SOURCES)) {
    const { gbpLocation } = SOURCES[source];
    const out = { selected: [], pushed: 0, failed: 0, skipped: 0, errors: [] };
    results[source] = out;

    let picks;
    try {
      picks = await selectForSource(source);
    } catch (e) {
      out.errors.push(e.message);
      continue;
    }
    out.selected = picks.map((p) => ({ photoId: p.photoId, groupKey: p.groupKey, url: p.url }));
    if (dryRun) continue;

    for (const pick of picks) {
      // Claim first. A unique-violation means another run got here — skip.
      const { data: claim, error: claimErr } = await supabase
        .from("gbp_photo_pushes")
        .insert({
          source,
          source_photo_id: pick.photoId,
          gbp_location: gbpLocation,
          source_url: pick.url,
        })
        .select("id")
        .single();
      if (claimErr || !claim) {
        out.skipped += 1;
        continue;
      }

      try {
        const mediaName = await pushOne(token, gbpLocation, source, pick.photoId);
        await supabase
          .from("gbp_photo_pushes")
          .update({ status: "pushed", media_name: mediaName })
          .eq("id", claim.id);
        out.pushed += 1;
      } catch (e) {
        const detail =
          JSON.stringify(e.response?.data?.error || e.response?.data || e.message).slice(0, 500);
        await supabase
          .from("gbp_photo_pushes")
          .update({ status: "failed", error: detail })
          .eq("id", claim.id);
        out.failed += 1;
        out.errors.push(`${pick.photoId}: ${detail}`);
      }
    }
  }
  return results;
}

async function pipelineStatus() {
  const { data, error } = await supabase
    .from("gbp_photo_pushes")
    .select("source, status, created_at, error, source_photo_id")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`ledger read: ${error.message}`);
  const tallies = {};
  for (const r of data || []) {
    tallies[r.source] ??= { claimed: 0, pushed: 0, failed: 0, lastRunAt: r.created_at };
    tallies[r.source][r.status] += 1;
  }
  const stuck = (data || []).filter((r) => r.status === "claimed");
  const recentFailures = (data || []).filter((r) => r.status === "failed").slice(0, 5);
  return { tallies, stuckClaims: stuck, recentFailures };
}

module.exports = { runCycle, pipelineStatus, jpegForPhoto, WEEKLY_CAP };
