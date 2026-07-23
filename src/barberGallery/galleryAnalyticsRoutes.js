// galleryAnalyticsRoutes.js — Gallery marketing analytics (per-image stats)
// future-marketing-platform-roadmap.md Phase 4, on the live barber gallery.
//
// POST /api/gallery/events   (public — called by the barbershop website)
//   Batched first-party events from /gallery + barber-page portfolios.
//   Accepts application/json AND text/plain (navigator.sendBeacon sends
//   text/plain to stay CORS-preflight-free on pagehide).
//   Body: { sessionId, page, referrer, utm?, events: [{ type, photoId, barberSlug }] }
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

const router = express.Router();

const EVENT_TYPES = new Set(["impression", "flip", "book_click", "bio_click", "conversion"]);
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
      if (!UUID_RE.test(String(e.photoId || ""))) continue;
      if (!SLUG_RE.test(String(e.barberSlug || ""))) continue;
      rows.push({
        event_type: e.type,
        photo_id: e.photoId,
        barber_slug: e.barberSlug,
        session_id: sessionId,
        page: clip(page),
        referrer: clip(referrer),
        utm_source: clip(utm?.source),
        utm_medium: clip(utm?.medium),
        utm_campaign: clip(utm?.campaign),
      });
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
