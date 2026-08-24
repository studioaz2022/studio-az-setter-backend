// galleryAnalyticsRoutes.js — Gallery marketing analytics (per-image stats)
// future-marketing-platform-roadmap.md Phase 4, on the live barber gallery.
//
// POST /api/gallery/events   (public — called by the barbershop website)
//   Batched first-party events from /gallery + barber-page portfolios.
//   Accepts application/json AND text/plain (navigator.sendBeacon sends
//   text/plain to stay CORS-preflight-free on pagehide).
//   Body: { sessionId, page, referrer, utm?, events: [{ type, photoId, barberSlug }] }
//   Filter taps (GALLERY_RANKING_PLAN.md Phase 1) ride the same batch as
//   { type: "filter", tag } — no photoId; stored with photo_id NULL.
//
// GET /api/gallery/stats?barber=<slug>&days=<n>   (per-image aggregates)
//   Counts DISTINCT sessions per photo per event type, so duplicate beacons
//   never inflate numbers. Enriched with photo url/caption from the
//   barber-gallery Supabase project (public read, anon key).
//
// No PII: session ids are random UUIDs minted in sessionStorage; events
// carry no name/phone/email. contact_id is only set later by the booking
// conversion path (server-side).

const express = require("express");
const { supabase } = require("../clients/supabaseClient");
const { readScores, PRODUCTION_ORIGINS } = require("./galleryRanking");

const router = express.Router();

const EVENT_TYPES = new Set(["impression", "flip", "book_click", "bio_click", "conversion", "filter"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,48}$/;
const MAX_EVENTS_PER_BATCH = 40;
const MAX_TEXT_LEN = 200;

// barber-gallery Supabase project — photos metadata (PUBLIC read via the
// publishable anon key; same key the website ships in its client bundle).
const GALLERY_REST = "https://bzojzrgoeknvijrmtdpe.supabase.co/rest/v1";
const GALLERY_ANON_KEY = "sb_publishable_Rw3jFBeMVVGAP11KaQDUBA_CJuXLfqU";

const clip = (v) => (typeof v === "string" ? v.slice(0, MAX_TEXT_LEN) : null);

// sendBeacon bodies arrive as text/plain — parse them like JSON.
router.use(express.text({ type: "text/plain", limit: "64kb" }));

router.post("/events", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: "Storage not configured" });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ success: false, error: "Invalid JSON" });
      }
    }

    const { sessionId, page, referrer, utm, events } = body || {};
    if (!UUID_RE.test(String(sessionId || ""))) {
      return res.status(400).json({ success: false, error: "sessionId must be a UUID" });
    }
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, error: "events must be a non-empty array" });
    }
    if (events.length > MAX_EVENTS_PER_BATCH) {
      return res.status(413).json({ success: false, error: `Max ${MAX_EVENTS_PER_BATCH} events per batch` });
    }

    const rows = [];
    for (const e of events) {
      if (!e || !EVENT_TYPES.has(e.type)) continue;
      const base = {
        event_type: e.type,
        session_id: sessionId,
        page: clip(page),
        referrer: clip(referrer),
        utm_source: clip(utm?.source),
        utm_medium: clip(utm?.medium),
        utm_campaign: clip(utm?.campaign),
        // Which site sent this — the scoring job only counts production
        // origins, which is what makes the launch cutover automatic.
        origin: clip(req.headers.origin) || null,
      };
      // filter taps carry a tag and no photo (GALLERY_RANKING_PLAN.md Phase 1);
      // keys stay uniform across the batch — PostgREST bulk insert requires it.
      if (e.type === "filter") {
        if (!SLUG_RE.test(String(e.tag || ""))) continue;
        rows.push({ ...base, photo_id: null, barber_slug: null, tag: e.tag });
      } else {
        if (!UUID_RE.test(String(e.photoId || ""))) continue;
        if (!SLUG_RE.test(String(e.barberSlug || ""))) continue;
        rows.push({ ...base, photo_id: e.photoId, barber_slug: e.barberSlug, tag: null });
      }
    }
    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: "No valid events in batch" });
    }

    const { error } = await supabase.from("gallery_events").insert(rows);
    if (error) throw error;

    return res.json({ success: true, inserted: rows.length });
  } catch (error) {
    console.error(`❌ [GalleryAnalytics] events insert failed: ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: "Event ingest failed" });
  }
});

// GET /api/gallery/scores — the ranking scores the website orders the wall
// by (GALLERY_RANKING_PLAN.md Phase 2). Public + cacheable: recomputed every
// 6h by galleryRanking.js, so 15 minutes of edge cache costs nothing.
router.get("/scores", async (_req, res) => {
  try {
    const { scores, scoredAt } = await readScores();
    res.set("Cache-Control", "public, max-age=900");
    return res.json({
      success: true,
      scoredAt,
      epoch: process.env.RANKING_EPOCH || null,
      scores,
    });
  } catch (error) {
    console.error(`❌ [GalleryAnalytics] scores read failed: ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: "Scores unavailable" });
  }
});

// GET /api/gallery/filter-demand?days=30 — demand vs supply per tag
// (GALLERY_RANKING_PLAN.md Phase 4). Demand = distinct sessions that tapped
// the tag's chip on the PRODUCTION site (same origin gate as scoring, so the
// coaching numbers describe real visitors); supply = live published photos
// carrying the tag. The uploader /stats turns the gap into "post tapers."
router.get("/filter-demand", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: "Storage not configured" });
    }
    // Optional ?barber=<slug>: adds a per-tag `mine` count (that barber's live
    // plates carrying the tag) so clients can mark open lanes server-truthfully.
    const barber = req.query.barber ? String(req.query.barber) : null;
    if (barber && !SLUG_RE.test(barber)) {
      return res.status(400).json({ success: false, error: "Invalid barber slug" });
    }
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data: taps, error } = await supabase
      .from("gallery_events")
      .select("tag, session_id, origin")
      .eq("event_type", "filter")
      .gte("created_at", since)
      .limit(50000);
    if (error) throw error;

    const sessionsByTag = new Map();
    for (const t of taps || []) {
      if (!t.tag || !PRODUCTION_ORIGINS.has(t.origin)) continue;
      let s = sessionsByTag.get(t.tag);
      if (!s) {
        s = new Set();
        sessionsByTag.set(t.tag, s);
      }
      s.add(t.session_id);
    }

    // Supply + labels from the gallery project (public read).
    const headers = {
      apikey: GALLERY_ANON_KEY,
      Authorization: `Bearer ${GALLERY_ANON_KEY}`,
    };
    const [photosRes, taxRes, barbersRes] = await Promise.all([
      fetch(
        `${GALLERY_REST}/gallery_photos?status=eq.published&select=barber_id,cut_pillar,tags`,
        { headers }
      ),
      fetch(
        `${GALLERY_REST}/gallery_tag_taxonomy?active=eq.true&select=slug,label`,
        { headers }
      ),
      barber
        ? fetch(`${GALLERY_REST}/barbers?slug=eq.${barber}&select=id`, { headers })
        : Promise.resolve(null),
    ]);
    const photos = photosRes.ok ? await photosRes.json() : [];
    const taxonomy = taxRes.ok ? await taxRes.json() : [];
    const barberIds = new Set(
      barbersRes?.ok ? (await barbersRes.json()).map((b) => b.id) : []
    );
    // Taxonomy labels are written for the tagging UI ("This is a Taper");
    // demand rows need the plain word — same cleanup the website chips do.
    const LABEL_OVERRIDES = { fade: "Fade", taper: "Taper", "burst-fade": "Burst Fade" };
    const labelBySlug = new Map(
      taxonomy.map((t) => [t.slug, LABEL_OVERRIDES[t.slug] || t.label])
    );

    const photosByTag = new Map();
    const mineByTag = new Map();
    for (const p of photos) {
      const tags = new Set([p.cut_pillar, ...(p.tags || [])].filter(Boolean));
      for (const tag of tags) {
        photosByTag.set(tag, (photosByTag.get(tag) || 0) + 1);
        if (barberIds.has(p.barber_id)) {
          mineByTag.set(tag, (mineByTag.get(tag) || 0) + 1);
        }
      }
    }

    const tags = [...sessionsByTag.entries()]
      .map(([tag, sessions]) => ({
        tag,
        label: labelBySlug.get(tag) || tag,
        sessions: sessions.size,
        photos: photosByTag.get(tag) || 0,
        ...(barber ? { mine: mineByTag.get(tag) || 0 } : {}),
      }))
      .sort((a, b) => b.sessions - a.sessions);

    res.set("Cache-Control", "public, max-age=900");
    return res.json({ success: true, days, ...(barber ? { barber } : {}), tags });
  } catch (error) {
    console.error(`❌ [GalleryAnalytics] filter-demand failed: ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: "Demand unavailable" });
  }
});

// GET /api/gallery/lane-leads?barber=<slug>&days=N — lane-attributed leads
// (GALLERY_RANKING_PLAN.md Phase 7a). A lane lead = same session, in time
// order: production-origin `filter` tap on tag T → conversion on one of this
// barber's photos carrying T. Route proven per real person, not correlation.
// The exposure multiplier separates strategy from routing: how much the lane
// amplified this barber vs the open wall — (mine_lane/pool_lane) ÷
// (mine_total/wall_total), computed on CURRENT pool counts (approximate,
// labeled so). nicheWin only at >= 2x: a fade-lane lead on a fade-heavy wall
// claims nothing. Counts, never rates — undercounting is the safe direction.
const NICHE_WIN_MULTIPLIER = 2;

router.get("/lane-leads", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: "Storage not configured" });
    }
    const barber = String(req.query.barber || "");
    if (!SLUG_RE.test(barber)) {
      return res.status(400).json({ success: false, error: "Invalid barber slug" });
    }
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [{ data: conversions, error: cErr }, { data: taps, error: fErr }] =
      await Promise.all([
        supabase
          .from("gallery_events")
          .select("photo_id, session_id, contact_id, is_new_client, created_at")
          .eq("event_type", "conversion")
          .eq("barber_slug", barber)
          .gte("created_at", since)
          .limit(10000),
        supabase
          .from("gallery_events")
          .select("tag, session_id, origin, created_at")
          .eq("event_type", "filter")
          .gte("created_at", since)
          .limit(50000),
      ]);
    if (cErr) throw cErr;
    if (fErr) throw fErr;

    // session → [{tag, at}] — production-origin taps only.
    const tapsBySession = new Map();
    for (const t of taps || []) {
      if (!t.tag || !PRODUCTION_ORIGINS.has(t.origin)) continue;
      let arr = tapsBySession.get(t.session_id);
      if (!arr) {
        arr = [];
        tapsBySession.set(t.session_id, arr);
      }
      arr.push({ tag: t.tag, at: t.created_at });
    }

    // Photo tags + pool counts from the gallery project (public read).
    const headers = {
      apikey: GALLERY_ANON_KEY,
      Authorization: `Bearer ${GALLERY_ANON_KEY}`,
    };
    const [photosRes, taxRes, barbersRes] = await Promise.all([
      fetch(
        `${GALLERY_REST}/gallery_photos?status=eq.published&select=id,barber_id,cut_pillar,tags`,
        { headers }
      ),
      fetch(`${GALLERY_REST}/gallery_tag_taxonomy?active=eq.true&select=slug,label`, { headers }),
      fetch(`${GALLERY_REST}/barbers?slug=eq.${barber}&select=id`, { headers }),
    ]);
    const photos = photosRes.ok ? await photosRes.json() : [];
    const taxonomy = taxRes.ok ? await taxRes.json() : [];
    const barberIds = new Set(barbersRes.ok ? (await barbersRes.json()).map((b) => b.id) : []);
    const LABELS = { fade: "Fade", taper: "Taper", "burst-fade": "Burst Fade" };
    const labelBySlug = new Map(taxonomy.map((t) => [t.slug, LABELS[t.slug] || t.label]));

    const tagsByPhoto = new Map();
    const poolByTag = new Map();
    const mineByTag = new Map();
    let mineTotal = 0;
    for (const p of photos) {
      const tags = new Set([p.cut_pillar, ...(p.tags || [])].filter(Boolean));
      tagsByPhoto.set(p.id, tags);
      const mine = barberIds.has(p.barber_id);
      if (mine) mineTotal++;
      for (const tag of tags) {
        poolByTag.set(tag, (poolByTag.get(tag) || 0) + 1);
        if (mine) mineByTag.set(tag, (mineByTag.get(tag) || 0) + 1);
      }
    }
    const wallTotal = photos.length;

    // Attribute: for each conversion, lanes = tags tapped BEFORE it in the
    // same session that the converted photo carries. A conversion crediting
    // several matching tags credits each lane once (they're the same person,
    // but lanes are judged independently).
    const lanes = new Map(); // tag → { leads:Set(session), newFaces:Set }
    for (const c of conversions || []) {
      const photoTags = tagsByPhoto.get(c.photo_id);
      if (!photoTags) continue;
      const sessionTaps = tapsBySession.get(c.session_id) || [];
      for (const tap of sessionTaps) {
        if (tap.at >= c.created_at) continue; // filter must precede conversion
        if (!photoTags.has(tap.tag)) continue;
        let lane = lanes.get(tap.tag);
        if (!lane) {
          lane = { leads: new Set(), newFaces: new Set() };
          lanes.set(tap.tag, lane);
        }
        lane.leads.add(c.session_id);
        if (c.is_new_client === true) lane.newFaces.add(c.contact_id || c.session_id);
      }
    }

    const results = [...lanes.entries()]
      .map(([tag, lane]) => {
        const mineLane = mineByTag.get(tag) || 0;
        const poolLane = poolByTag.get(tag) || 0;
        const laneShare = poolLane > 0 ? mineLane / poolLane : 0;
        const wallShare = wallTotal > 0 ? mineTotal / wallTotal : 0;
        const multiplier = wallShare > 0 ? laneShare / wallShare : 0;
        return {
          tag,
          label: labelBySlug.get(tag) || tag,
          leads: lane.leads.size,
          newFaces: lane.newFaces.size,
          minePlates: mineLane,
          lanePlates: poolLane,
          multiplier: Math.round(multiplier * 10) / 10,
          nicheWin: multiplier >= NICHE_WIN_MULTIPLIER,
        };
      })
      .sort((a, b) => b.leads - a.leads);

    res.set("Cache-Control", "public, max-age=900");
    return res.json({ success: true, barber, days, lanes: results });
  } catch (error) {
    console.error(`❌ [GalleryAnalytics] lane-leads failed: ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: "Lane leads unavailable" });
  }
});

// GET /api/gallery/price-history?barber=<slug> — this barber's rows from the
// barber_price_history ledger (GALLERY_RANKING_PLAN.md Phase 5/6). Public
// read; prices are already public on the website. Baselines are internal
// anchor rows, not price *moves* — callers get changes only.
router.get("/price-history", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: "Storage not configured" });
    }
    const barber = String(req.query.barber || "");
    if (!SLUG_RE.test(barber)) {
      return res.status(400).json({ success: false, error: "Invalid barber slug" });
    }
    const { data, error } = await supabase
      .from("barber_price_history")
      .select("service_type, old_price, new_price, effective_at, source")
      .eq("barber_slug", barber)
      .neq("source", "baseline")
      .order("effective_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.set("Cache-Control", "public, max-age=900");
    return res.json({
      success: true,
      barber,
      events: (data || []).map((e) => ({
        serviceType: e.service_type,
        oldPrice: e.old_price === null ? null : Number(e.old_price),
        newPrice: Number(e.new_price),
        effectiveAt: e.effective_at,
        source: e.source,
      })),
    });
  } catch (error) {
    console.error(`❌ [GalleryAnalytics] price-history failed: ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: "Price history unavailable" });
  }
});

// Aggregate per-photo stats. Distinct-session counting happens here (not in
// SQL) — volumes are tiny for now; move to an RPC when they aren't.
router.get("/stats", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: "Storage not configured" });
    }

    const barber = req.query.barber ? String(req.query.barber) : null;
    if (barber && !SLUG_RE.test(barber)) {
      return res.status(400).json({ success: false, error: "Invalid barber slug" });
    }
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from("gallery_events")
      .select("event_type, photo_id, barber_slug, session_id, contact_id, is_new_client")
      .gte("created_at", since)
      .limit(50000);
    if (barber) query = query.eq("barber_slug", barber);

    const { data: events, error } = await query;
    if (error) throw error;

    // photo_id → { type → Set(session_id), newClients: Set(contact) }
    const byPhoto = new Map();
    for (const ev of events || []) {
      if (!ev.photo_id) continue; // filter taps carry no photo — not per-photo stats
      let photo = byPhoto.get(ev.photo_id);
      if (!photo) {
        photo = { barberSlug: ev.barber_slug, sessions: {}, newClients: new Set() };
        byPhoto.set(ev.photo_id, photo);
      }
      (photo.sessions[ev.event_type] ??= new Set()).add(ev.session_id);
      // "brand-new client brought in by this print" — distinct contacts whose
      // first-ever GHL record was created by a booking this photo converted.
      if (ev.event_type === "conversion" && ev.is_new_client === true) {
        photo.newClients.add(ev.contact_id || ev.session_id);
      }
    }

    // Enrich with photo metadata (public read; stats still return if this fails).
    let metaById = new Map();
    try {
      const ids = [...byPhoto.keys()];
      if (ids.length > 0) {
        const metaRes = await fetch(
          `${GALLERY_REST}/gallery_photos?id=in.(${ids.join(",")})&select=id,url,caption,cut_pillar,status`,
          { headers: { apikey: GALLERY_ANON_KEY, Authorization: `Bearer ${GALLERY_ANON_KEY}` } }
        );
        if (metaRes.ok) {
          metaById = new Map((await metaRes.json()).map((p) => [p.id, p]));
        }
      }
    } catch (e) {
      console.warn(`⚠️ [GalleryAnalytics] photo enrichment failed: ${e.message?.slice(0, 120)}`);
    }

    const photos = [...byPhoto.entries()]
      .map(([photoId, { barberSlug, sessions, newClients }]) => {
        const count = (t) => sessions[t]?.size || 0;
        const impressions = count("impression");
        const flips = count("flip");
        // Sessions that opened the print AND took a CTA on it — the
        // "did the photo move them?" signal. Same-session co-occurrence;
        // gallery CTAs live on the card back, so open-first is structural.
        let actedSessions = 0;
        const flipSet = sessions.flip;
        if (flipSet) {
          const acted = new Set([
            ...(sessions.book_click || []),
            ...(sessions.bio_click || []),
          ]);
          for (const s of acted) if (flipSet.has(s)) actedSessions += 1;
        }
        const meta = metaById.get(photoId);
        return {
          photoId,
          barberSlug,
          url: meta?.url || null,
          caption: meta?.caption || null,
          cutPillar: meta?.cut_pillar || null,
          status: meta?.status || null,
          impressions,
          flips,
          bookClicks: count("book_click"),
          bioClicks: count("bio_click"),
          conversions: count("conversion"),
          newClients: newClients.size,
          flipRate: impressions > 0 ? +(flips / impressions).toFixed(4) : null,
          actionRate: flips > 0 ? +(actedSessions / flips).toFixed(4) : null,
        };
      })
      .sort((a, b) => b.impressions - a.impressions);

    const totals = photos.reduce(
      (acc, p) => {
        acc.impressions += p.impressions;
        acc.flips += p.flips;
        acc.bookClicks += p.bookClicks;
        acc.bioClicks += p.bioClicks;
        acc.conversions += p.conversions;
        acc.newClients += p.newClients;
        return acc;
      },
      { impressions: 0, flips: 0, bookClicks: 0, bioClicks: 0, conversions: 0, newClients: 0 }
    );

    return res.json({ success: true, days, barber, totals, photos });
  } catch (error) {
    console.error(`❌ [GalleryAnalytics] stats failed: ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: "Stats aggregation failed" });
  }
});

module.exports = router;
