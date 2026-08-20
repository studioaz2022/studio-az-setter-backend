// galleryRanking.js — gallery ranking score computation (GALLERY_RANKING_PLAN.md Phase 2)
//
// Every 6h (and once on boot): pull gallery_events, compute a prior-smoothed
// engagement rate per published photo, and upsert gallery_photo_scores with a
// full `breakdown` receipt. The website orders the wall by these scores
// (presentation rules — audition slots, interleave — live client-side in the
// website's lib/ranking.ts); the uploader /stats shows barbers the receipts.
//
// The score, exactly as the plan specifies:
//   engagement = 1·flips + 2·bio + 5·book + 25·conversions + 15·newClients
//   globalRate = Σ engagement / Σ impressions        (published photos, window)
//   score      = (engagement + PRIOR·globalRate) / (impressions + PRIOR)
// All counts are DISTINCT SESSIONS within a rolling 90-day window.
//
// LAUNCH IS AUTOMATIC — no Render step at DNS cutover. View events (impression
// /flip/bio/book) count ONLY when their stored `origin` is a production origin
// (minneapolisbarbershop.com), so the ranking clock starts by itself with the
// first real-domain visitor, and bay/localhost testing is excluded forever.
// Conversions have no browser origin (recorded server-side off a confirmed
// booking) and always count — they're money-real, and test bookings get
// cleaned up per house rule. RANKING_EPOCH (env, ISO) remains as an optional
// EXTRA time gate on top (unset = origin gate alone). Fairness invariants:
// identical prior for every photo, no per-barber terms anywhere, counts are
// rates.

const { supabase } = require("../clients/supabaseClient");

// Same public gallery-project read the stats endpoint uses.
const GALLERY_REST = "https://bzojzrgoeknvijrmtdpe.supabase.co/rest/v1";
const GALLERY_ANON_KEY = "sb_publishable_Rw3jFBeMVVGAP11KaQDUBA_CJuXLfqU";

// Constants table in GALLERY_RANKING_PLAN.md — tune there, change here.
// View events count only from these origins — the automatic launch gate.
const PRODUCTION_ORIGINS = new Set([
  "https://minneapolisbarbershop.com",
  "https://www.minneapolisbarbershop.com",
]);

const WEIGHTS = { flip: 1, bio_click: 2, book_click: 5, conversion: 25 };
const NEW_CLIENT_BONUS = 15;
const PRIOR_IMPRESSIONS = 30;
const WINDOW_DAYS = 90;
const AUDITION_IMPRESSIONS = 150;
const TICK_MS = 6 * 3600 * 1000;
const EVENT_FETCH_LIMIT = 50000; // move to an RPC when volumes outgrow this

function rankingEpoch() {
  const raw = process.env.RANKING_EPOCH;
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    console.error(`[GalleryRanking] RANKING_EPOCH "${raw}" is not a date — ignoring (shadow mode)`);
    return null;
  }
  return d;
}

async function fetchPublishedPhotoIds() {
  const res = await fetch(
    `${GALLERY_REST}/gallery_photos?status=eq.published&select=id`,
    { headers: { apikey: GALLERY_ANON_KEY, Authorization: `Bearer ${GALLERY_ANON_KEY}` } }
  );
  if (!res.ok) throw new Error(`gallery_photos fetch ${res.status}`);
  return (await res.json()).map((p) => p.id);
}

/**
 * Compute and upsert scores for every published photo. Returns a summary
 * for logs/manual runs. Exported for the boot/interval loop and for tests.
 */
async function runScoringOnce() {
  if (!supabase) throw new Error("Storage not configured");
  const epoch = rankingEpoch();
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
  // Audition counts everything since epoch; the score only the last 90 days.
  // One fetch covers both: since epoch when set, else since the table began.
  const fetchSince = epoch || new Date("2026-07-01T00:00:00Z");

  const published = await fetchPublishedPhotoIds();
  const publishedSet = new Set(published);

  const { data: events, error } = await supabase
    .from("gallery_events")
    .select("event_type, photo_id, session_id, contact_id, is_new_client, created_at, origin")
    .gte("created_at", fetchSince.toISOString())
    .neq("event_type", "filter")
    .limit(EVENT_FETCH_LIMIT);
  if (error) throw new Error(error.message);
  if ((events || []).length >= EVENT_FETCH_LIMIT) {
    console.error(`[GalleryRanking] event fetch hit the ${EVENT_FETCH_LIMIT} cap — window is UNDERCOUNTED, move to an RPC`);
  }

  // photo → { sinceEpochImpr: Set, windowed: { type: Set }, newClients: Set }
  const perPhoto = new Map();
  for (const ev of events || []) {
    if (!ev.photo_id || !publishedSet.has(ev.photo_id)) continue;
    // The automatic launch gate: browser-sent view events must come from the
    // production site. Server-recorded conversions carry no origin and pass.
    if (ev.event_type !== "conversion" && !PRODUCTION_ORIGINS.has(ev.origin)) continue;
    let p = perPhoto.get(ev.photo_id);
    if (!p) {
      p = { sinceEpochImpr: new Set(), windowed: {}, newClients: new Set() };
      perPhoto.set(ev.photo_id, p);
    }
    if (ev.event_type === "impression") p.sinceEpochImpr.add(ev.session_id);
    if (new Date(ev.created_at) >= windowStart) {
      (p.windowed[ev.event_type] ??= new Set()).add(ev.session_id);
      if (ev.event_type === "conversion" && ev.is_new_client === true) {
        p.newClients.add(ev.contact_id || ev.session_id);
      }
    }
  }

  // First pass: raw counts + the global rate (identical prior for everyone).
  const counts = new Map();
  let sumEngagement = 0;
  let sumImpressions = 0;
  for (const id of published) {
    const p = perPhoto.get(id);
    const w = p?.windowed || {};
    const c = {
      impressions: w.impression?.size || 0,
      flips: w.flip?.size || 0,
      bioClicks: w.bio_click?.size || 0,
      bookClicks: w.book_click?.size || 0,
      conversions: w.conversion?.size || 0,
      newClients: p?.newClients.size || 0,
      impressionsSinceEpoch: p?.sinceEpochImpr.size || 0,
    };
    c.engagement =
      WEIGHTS.flip * c.flips +
      WEIGHTS.bio_click * c.bioClicks +
      WEIGHTS.book_click * c.bookClicks +
      WEIGHTS.conversion * c.conversions +
      NEW_CLIENT_BONUS * c.newClients;
    counts.set(id, c);
    sumEngagement += c.engagement;
    sumImpressions += c.impressions;
  }
  const globalRate = sumImpressions > 0 ? sumEngagement / sumImpressions : 0;

  const computedAt = new Date().toISOString();
  const rows = published.map((id) => {
    const c = counts.get(id);
    const score =
      (c.engagement + PRIOR_IMPRESSIONS * globalRate) /
      (c.impressions + PRIOR_IMPRESSIONS);
    return {
      photo_id: id,
      score,
      auditioning: c.impressionsSinceEpoch < AUDITION_IMPRESSIONS,
      breakdown: {
        ...c,
        rawRate: c.impressions > 0 ? c.engagement / c.impressions : null,
        globalRate,
        priorImpressions: PRIOR_IMPRESSIONS,
        windowDays: WINDOW_DAYS,
        auditionThreshold: AUDITION_IMPRESSIONS,
        epoch: epoch ? epoch.toISOString() : null,
        computedAt,
      },
      scored_at: computedAt,
    };
  });

  if (rows.length > 0) {
    const { error: upsertErr } = await supabase
      .from("gallery_photo_scores")
      .upsert(rows, { onConflict: "photo_id" });
    if (upsertErr) throw new Error(upsertErr.message);
  }

  const summary = {
    photos: rows.length,
    events: (events || []).length,
    globalRate: Number(globalRate.toFixed(4)),
    epoch: epoch ? epoch.toISOString() : null,
  };
  console.log(
    `[GalleryRanking] scored ${summary.photos} photos from ${summary.events} events (globalRate ${summary.globalRate}, epoch ${summary.epoch || "unset/shadow"})`
  );
  return summary;
}

/** Read the score table as { photoId: { score, auditioning, breakdown } }. */
async function readScores() {
  if (!supabase) throw new Error("Storage not configured");
  const { data, error } = await supabase
    .from("gallery_photo_scores")
    .select("photo_id, score, auditioning, breakdown, scored_at");
  if (error) throw new Error(error.message);
  const scores = {};
  let scoredAt = null;
  for (const r of data || []) {
    scores[r.photo_id] = {
      score: Number(r.score),
      auditioning: r.auditioning,
      breakdown: r.breakdown,
    };
    if (!scoredAt || r.scored_at > scoredAt) scoredAt = r.scored_at;
  }
  return { scores, scoredAt };
}

function startGalleryRankingLoop() {
  const tick = async () => {
    try {
      await runScoringOnce();
    } catch (e) {
      console.error("[GalleryRanking] scoring tick failed:", e.message);
    }
  };
  setTimeout(tick, 60_000); // startup grace, then every 6h
  setInterval(tick, TICK_MS);
  console.log("[GalleryRanking] scoring loop started (6h interval)");
}

module.exports = { runScoringOnce, readScores, startGalleryRankingLoop };
