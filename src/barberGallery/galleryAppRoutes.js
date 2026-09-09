// galleryAppRoutes.js — the barber gallery, for the iOS app.
//
// WHY THIS EXISTS, and why it is not just the web uploader's endpoints:
//
// The gallery lives in its own Supabase project (barber-gallery) whose tables are
// RLS-guarded per barber. The web uploader satisfies that by holding a gallery
// session and writing rows as the signed-in barber. The iOS app is signed into a
// DIFFERENT project (Studio AZ App) and we don't want barbers signing in twice on
// a device they've already unlocked and authenticated on.
//
// So the trust is moved server-side. Every route here:
//
//   1. requires the first-party `x-internal-key`, and
//   2. VERIFIES the caller's Studio AZ App access token against that project, and
//   3. resolves which barber they are FROM THAT TOKEN.
//
// Step 3 is the part that matters. The app never names a barber, a barber id, or
// a GHL user id — if it could, the shared internal key (which ships inside the
// app binary and can be extracted from it) would be enough to read and rewrite
// any barber's book. Because identity comes from a token the caller cannot forge,
// removing the second login costs nothing in isolation between barbers.
//
// Writes use the gallery project's secret key, so they bypass RLS — which is
// exactly why the barber_id on every one of them is taken from the resolved
// session and never from the request body.

const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { HttpError, processUpload, processRecrop, deleteGhlFile } = require("./galleryPipeline");
const hours = require("../barberHours/barberHoursRoutes");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

router.use(express.json({ limit: "256kb" }));

// ── Clients ───────────────────────────────────────────────────────────────

const GALLERY_URL = process.env.GALLERY_SUPABASE_URL;
const GALLERY_SECRET = process.env.GALLERY_SUPABASE_SECRET_KEY;

let gallery = null;
if (GALLERY_URL && GALLERY_SECRET) {
  gallery = createClient(GALLERY_URL, GALLERY_SECRET, { auth: { persistSession: false } });
  console.log("[GalleryApp] barber-gallery client initialized");
} else {
  console.warn("[GalleryApp] GALLERY_SUPABASE_URL / GALLERY_SUPABASE_SECRET_KEY not set — iOS gallery disabled");
}

const PILLARS = new Set(["fade", "classic-cut", "long-hair", "afro"]);
const STATUSES = new Set(["pending_review", "published", "hidden", "rejected"]);

// ── Auth ──────────────────────────────────────────────────────────────────

function requireInternalKey(req, res, next) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return res.status(503).json({ success: false, error: "INTERNAL_API_KEY not configured on server" });
  }
  if (req.get("x-internal-key") !== expected) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

/**
 * Verify the caller's Studio AZ App access token with that project's own auth
 * server. This is the whole security model: a token can't be forged, so whoever
 * this returns is who the caller actually is.
 */
async function verifyAppUser(accessToken) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(503, "App auth is not configured on the server");

  let response;
  try {
    response = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, "Could not verify your session");
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, "Your session expired. Sign in again.");
  }
  if (!response.ok) throw new HttpError(502, "Could not verify your session");

  const user = await response.json().catch(() => null);
  if (!user?.id) throw new HttpError(401, "Your session expired. Sign in again.");
  return user;
}

/**
 * Token → app user → barber row in the gallery project.
 *
 * Matched on email first (the gallery's `barbers.email` is unique and is what
 * the web uploader binds on, so the two paths agree on identity), falling back
 * to ghl_user_id for anyone whose shop email differs from their login.
 */
async function resolveBarber(req, res, next) {
  try {
    if (!gallery) throw new HttpError(503, "The gallery isn't configured on the server yet.");

    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "Missing session token");

    const appUser = await verifyAppUser(token);
    const email = String(appUser.email || "").toLowerCase();

    // The app's own `profiles` row carries the GHL user id used for hours.
    let appGhlUserId = null;
    try {
      const { supabase } = require("../clients/supabaseClient");
      if (supabase) {
        const { data } = await supabase
          .from("profiles")
          .select("ghl_user_id")
          .eq("id", appUser.id)
          .maybeSingle();
        appGhlUserId = data?.ghl_user_id || null;
      }
    } catch {
      /* hours will simply be unavailable; the book still works */
    }

    let barber = null;
    if (email) {
      const { data } = await gallery
        .from("barbers")
        .select("id, slug, first_name, full_name, ghl_media_folder_id, ghl_user_id, active")
        .eq("email", email)
        .maybeSingle();
      barber = data || null;
    }
    if (!barber && appGhlUserId) {
      const { data } = await gallery
        .from("barbers")
        .select("id, slug, first_name, full_name, ghl_media_folder_id, ghl_user_id, active")
        .eq("ghl_user_id", appGhlUserId)
        .maybeSingle();
      barber = data || null;
    }

    if (!barber) throw new HttpError(403, "NO_CHAIR");
    if (barber.active === false) throw new HttpError(403, "NO_CHAIR");

    req.barber = barber;
    req.ghlUserId = barber.ghl_user_id || appGhlUserId;
    next();
  } catch (error) {
    next(error);
  }
}

router.use(requireInternalKey);
router.use(resolveBarber);

// ── Shapes ────────────────────────────────────────────────────────────────

const shapeBarber = (b) => ({
  barberId: b.id,
  slug: b.slug,
  firstName: b.first_name,
  fullName: b.full_name,
  ghlMediaFolderId: b.ghl_media_folder_id,
});

/** Wrap a handler so thrown HttpErrors become their status and nothing else leaks. */
const handle = (what, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      // "NO_CHAIR" is a sentinel the app renders as its own screen, not a banner.
      return res.status(error.status).json({ success: false, error: error.message });
    }
    console.error(`❌ [GalleryApp] ${what} failed: ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: `Couldn't ${what}.` });
  }
};

// ── Reads ─────────────────────────────────────────────────────────────────

router.get(
  "/me",
  handle("load your account", async (req, res) => {
    res.json({ success: true, barber: shapeBarber(req.barber), hasHours: Boolean(req.ghlUserId) });
  })
);

router.get(
  "/taxonomy",
  handle("load the tags", async (_req, res) => {
    const { data, error } = await gallery.from("gallery_tag_taxonomy").select("*").eq("active", true);
    if (error) throw new HttpError(502, error.message);
    res.json({ success: true, taxonomy: data || [] });
  })
);

router.get(
  "/photos",
  handle("load your book", async (req, res) => {
    // The barber's arranged order drives their public bio page; newest-first only
    // breaks ties, because every row starts at sort_order 0.
    const { data, error } = await gallery
      .from("gallery_photos")
      .select("*")
      .eq("barber_id", req.barber.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) throw new HttpError(502, error.message);
    res.json({ success: true, photos: data || [] });
  })
);

// ── Upload ────────────────────────────────────────────────────────────────

router.post(
  "/photos",
  upload.single("file"),
  handle("post that photo", async (req, res) => {
    if (!req.barber.ghl_media_folder_id) {
      throw new HttpError(500, "Your media folder isn't set up yet. Ask Lionel.");
    }

    let tags;
    try {
      tags = JSON.parse(req.body.tags || "[]");
    } catch {
      throw new HttpError(400, "tags must be a JSON array");
    }
    const cutPillar = String(req.body.cutPillar || "");
    if (!PILLARS.has(cutPillar)) throw new HttpError(400, "Pick the cut.");

    const processed = await processUpload({
      buffer: req.file?.buffer,
      barberSlug: req.barber.slug,
      barberFirst: req.barber.first_name,
      ghlFolderId: req.barber.ghl_media_folder_id,
      cutPillar,
      tags,
    });

    const caption = String(req.body.caption || "").trim();
    const { data, error } = await gallery
      .from("gallery_photos")
      .insert({
        barber_id: req.barber.id, // from the verified session, never the body
        cut_pillar: cutPillar,
        tags,
        alt_text: processed.altText,
        seo_filename: processed.seoFilename,
        caption: caption || null,
        width: processed.width,
        height: processed.height,
        ghl_file_id: processed.ghlFileId,
        url: processed.url,
      })
      .select()
      .single();

    if (error || !data) {
      // Orphaned bytes — clean up so GHL doesn't accumulate files nothing points at.
      deleteGhlFile(processed.ghlFileId).catch(() => {});
      throw new HttpError(502, error?.message || "The photo uploaded but didn't save.");
    }
    res.json({ success: true, photo: data });
  })
);

// ── Edits ─────────────────────────────────────────────────────────────────

/** Reads a row only if this barber owns it. Stands in for the RLS the web has. */
async function ownedPhoto(barberId, photoId) {
  const { data } = await gallery
    .from("gallery_photos")
    .select("*")
    .eq("id", photoId)
    .eq("barber_id", barberId)
    .maybeSingle();
  if (!data) throw new HttpError(404, "Photo not found");
  return data;
}

router.patch(
  "/photos/:id",
  handle("save that change", async (req, res) => {
    await ownedPhoto(req.barber.id, req.params.id);

    // Allow-list, so a stray field can't rewrite url, ghl_file_id or barber_id.
    const patch = {};
    const body = req.body || {};
    if (typeof body.featured === "boolean") patch.featured = body.featured;
    if ("caption" in body) {
      const caption = String(body.caption ?? "").trim();
      patch.caption = caption || null;
    }
    if (Number.isInteger(body.sortOrder)) patch.sort_order = body.sortOrder;
    if (body.cutPillar || body.tags) {
      if (!PILLARS.has(String(body.cutPillar))) throw new HttpError(400, "Pick the cut.");
      if (!Array.isArray(body.tags) || !body.tags.includes(body.cutPillar)) {
        throw new HttpError(400, "tags must include the cut.");
      }
      patch.cut_pillar = body.cutPillar;
      patch.tags = body.tags;
    }
    if (typeof body.status === "string") {
      if (!STATUSES.has(body.status)) throw new HttpError(400, "Unknown status");
      patch.status = body.status;
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to save");

    const { data, error } = await gallery
      .from("gallery_photos")
      .update(patch)
      .eq("id", req.params.id)
      .eq("barber_id", req.barber.id)
      .select()
      .single();
    if (error || !data) throw new HttpError(502, error?.message || "Couldn't save that change.");
    res.json({ success: true, photo: data });
  })
);

/** Several sort_order writes in one request — the whole wall reorders at once. */
router.patch(
  "/photos",
  handle("save your order", async (req, res) => {
    const order = req.body?.order;
    if (!Array.isArray(order) || order.length === 0) throw new HttpError(400, "order is required");
    if (order.length > 300) throw new HttpError(400, "Too many photos in one save");

    const ids = order.map((row) => String(row.id));
    const { data: owned, error: ownErr } = await gallery
      .from("gallery_photos")
      .select("id")
      .eq("barber_id", req.barber.id)
      .in("id", ids);
    if (ownErr) throw new HttpError(502, ownErr.message);
    if ((owned || []).length !== ids.length) throw new HttpError(404, "Some photos aren't yours");

    for (const row of order) {
      if (!Number.isInteger(row.sortOrder)) throw new HttpError(400, "sortOrder must be an integer");
      const { error } = await gallery
        .from("gallery_photos")
        .update({ sort_order: row.sortOrder })
        .eq("id", String(row.id))
        .eq("barber_id", req.barber.id);
      if (error) throw new HttpError(502, error.message);
    }
    res.json({ success: true });
  })
);

router.post(
  "/photos/:id/recrop",
  handle("save the new crop", async (req, res) => {
    if (!req.barber.ghl_media_folder_id) {
      throw new HttpError(500, "Your media folder isn't set up yet. Ask Lionel.");
    }
    const photo = await ownedPhoto(req.barber.id, req.params.id);

    const processed = await processRecrop({
      sourceUrl: photo.url,
      ghlFolderId: req.barber.ghl_media_folder_id,
      seoFilename: photo.seo_filename,
      crop: req.body?.crop,
    });

    // Repoint the row BEFORE dropping the old bytes, so a failure anywhere
    // leaves the row pointing at a file that exists.
    const { data, error } = await gallery
      .from("gallery_photos")
      .update({
        url: processed.url,
        ghl_file_id: processed.ghlFileId,
        width: processed.width,
        height: processed.height,
      })
      .eq("id", photo.id)
      .eq("barber_id", req.barber.id)
      .select()
      .single();

    if (error || !data) {
      deleteGhlFile(processed.ghlFileId).catch(() => {});
      throw new HttpError(502, error?.message || "Couldn't save the new crop.");
    }
    if (photo.ghl_file_id && photo.ghl_file_id !== processed.ghlFileId) {
      deleteGhlFile(photo.ghl_file_id).catch(() => {});
    }
    res.json({ success: true, photo: data });
  })
);

router.delete(
  "/photos/:id",
  handle("delete that photo", async (req, res) => {
    const photo = await ownedPhoto(req.barber.id, req.params.id);

    // Bytes first: if this fails the row stays and the delete is retryable,
    // rather than leaving a row pointing at nothing.
    await deleteGhlFile(photo.ghl_file_id);

    const { error } = await gallery
      .from("gallery_photos")
      .delete()
      .eq("id", photo.id)
      .eq("barber_id", req.barber.id);
    if (error) throw new HttpError(502, error.message);
    res.json({ success: true });
  })
);

// ── Hours ─────────────────────────────────────────────────────────────────
//
// Proxied rather than called directly by the app for the same reason as
// everything else here: the GHL user id comes from the resolved session, so
// there is no request in which a barber can name someone else's schedule.

router.get(
  "/hours",
  handle("load your hours", async (req, res) => {
    if (!req.ghlUserId) throw new HttpError(400, "Your account isn't wired for hours yet. Ask Lionel.");
    if (!hours.findBarber(req.ghlUserId)) throw new HttpError(404, "Unknown barber");

    const schedules = (await hours.searchSchedules(req.ghlUserId)).map(hours.shapeSchedule);
    const known = schedules.filter((s) => s.serviceKey);
    known.sort(
      (a, b) => hours.SERVICE_ORDER.indexOf(a.serviceKey) - hours.SERVICE_ORDER.indexOf(b.serviceKey)
    );
    await Promise.all(
      known.map(async (s) => {
        try {
          s.booking = await hours.readBookingSettings(req.ghlUserId, s.serviceKey);
        } catch {
          s.booking = null;
        }
      })
    );
    res.json({ success: true, firstName: req.barber.first_name, schedules: known });
  })
);

/**
 * Weekly hours and booking settings hit different GHL APIs (Schedules vs the
 * calendar), so this is two upstream calls. Hours go FIRST on purpose: if the
 * calendar write then fails, availability is already correct and only the slot
 * settings need retrying.
 */
router.put(
  "/hours/:scheduleId",
  handle("save your hours", async (req, res) => {
    if (!req.ghlUserId) throw new HttpError(400, "Your account isn't wired for hours yet. Ask Lionel.");

    const base = `http://127.0.0.1:${process.env.PORT || 3000}/api/barber-hours/schedules/${encodeURIComponent(req.params.scheduleId)}`;
    const headers = { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY };

    // The schedule PUT carries a history snapshot and an ownership re-check that
    // are worth keeping in one place, so this hops through the existing route
    // rather than reimplementing them. Loopback, same process.
    async function put(url, body) {
      const response = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502,
          payload.error || "Couldn't save your hours");
      }
      return payload;
    }

    if (Array.isArray(req.body?.rules)) {
      await put(base, { userId: req.ghlUserId, rules: req.body.rules });
    }
    let booking = null;
    if (req.body?.booking) {
      const saved = await put(`${base}/booking`, {
        userId: req.ghlUserId,
        slotDuration: req.body.booking.slotDuration,
        slotInterval: req.body.booking.slotInterval,
      });
      booking = saved.booking ?? null;
    }
    res.json({ success: true, booking });
  })
);

// ── Stats ─────────────────────────────────────────────────────────────────
//
// Fans out the four public gallery-analytics endpoints, barber-scoped here so
// the app can't ask for someone else's numbers. Everything but the core stats
// call fails soft — a missing wall or demand panel costs those sections, not
// the screen.

router.get(
  "/stats",
  handle("load your stats", async (req, res) => {
    const allowed = new Set([7, 30, 90]);
    const requested = Number(req.query.days) || 30;
    const days = allowed.has(requested) ? requested : 30;
    const slug = encodeURIComponent(req.barber.slug);
    const base = `http://127.0.0.1:${process.env.PORT || 3000}/api/gallery`;

    const get = async (path) => {
      try {
        const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    };

    const [core, scores, demand, lanes] = await Promise.all([
      get(`/stats?barber=${slug}&days=${days}`),
      get(`/scores`),
      get(`/filter-demand?days=${days}&barber=${slug}`),
      get(`/lane-leads?barber=${slug}&days=${days}`),
    ]);

    if (!core?.success) throw new HttpError(502, core?.error || "Stats unavailable");

    // Wall ranks: merit order by score across every published photo.
    let wall = null;
    if (scores?.success && scores.scores) {
      const entries = Object.entries(scores.scores).sort((a, b) => b[1].score - a[1].score);
      wall = {};
      entries.forEach(([photoId, s], i) => {
        wall[photoId] = {
          rank: i + 1,
          total: entries.length,
          auditioning: Boolean(s.auditioning),
          looks: s.breakdown?.impressionsSinceEpoch ?? 0,
          auditionThreshold: s.breakdown?.auditionThreshold ?? 150,
        };
      });
    }

    let demandTags = null;
    if (demand?.success && Array.isArray(demand.tags)) {
      demandTags = demand.tags;
      if (lanes?.success && Array.isArray(lanes.lanes)) {
        const byTag = new Map(lanes.lanes.map((l) => [l.tag, l]));
        demandTags = demandTags.map((t) => {
          const lane = byTag.get(t.tag);
          return lane
            ? { ...t, leads: lane.leads, newFaces: lane.newFaces, multiplier: lane.multiplier, nicheWin: lane.nicheWin }
            : t;
        });
      }
    }

    res.json({
      success: true,
      days,
      totals: core.totals,
      photos: core.photos || [],
      wall,
      demand: demandTags,
    });
  })
);

// Errors thrown by the auth middleware land here.
router.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }
  console.error(`❌ [GalleryApp] unhandled: ${error?.message?.slice(0, 200)}`);
  return res.status(500).json({ success: false, error: "Something went wrong." });
});

module.exports = router;
