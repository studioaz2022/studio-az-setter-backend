// tattooPortfolioRoutes.js — tattoo artist portfolios, for the iOS app and the
// public website.
//
// Same trust model as /api/gallery-app: the artist's Studio AZ App access token
// is verified against that project, and the ARTIST IS RESOLVED FROM THE TOKEN.
// The app never names an artist, an artist id, or a slug on any write — if it
// could, the shared x-internal-key (which ships inside the app binary) would be
// enough to rewrite anyone's portfolio.
//
// Simpler than the barbershop's version in one respect: the tattoo tables live
// in the SAME Supabase project the app authenticates against, so there is no
// cross-project bridge — just the service-role client the backend already has.
//
// The /public route is the exception: no auth, because it feeds
// tattooshopminneapolis.com. The website reads through here rather than through
// Supabase directly, on purpose — this project has 38 tables with RLS off, so
// its publishable key must not end up in a public web bundle.

const express = require("express");
const multer = require("multer");
const { supabase } = require("../clients/supabaseClient");
const { HttpError } = require("./galleryPipeline");
const pipeline = require("./tattooPipeline");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

const PHOTO_COLUMNS =
  "id, artist_id, style, placement, status, alt_text, seo_filename, caption, width, height, ghl_file_id, url, featured, sort_order, created_at";

// ── Public read (the website) ──────────────────────────────────────────────

/**
 * Every published photo, grouped by artist slug. The site renders this instead
 * of the hardcoded images[] array it used to carry.
 *
 * Deliberately unauthenticated and cacheable: this is the same data anyone can
 * already see by loading a bio page.
 */
router.get("/public", async (_req, res) => {
  try {
    if (!supabase) throw new HttpError(503, "Storage not configured");

    const { data, error } = await supabase
      .from("tattoo_portfolio_photos")
      .select(`style, placement, alt_text, url, caption, featured, sort_order,
               tattoo_artists!inner ( slug, full_name, active )`)
      .eq("status", "published")
      .eq("tattoo_artists.active", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) throw new HttpError(502, error.message);

    const byArtist = {};
    for (const row of data || []) {
      const slug = row.tattoo_artists?.slug;
      if (!slug) continue;
      (byArtist[slug] ??= []).push({
        src: row.url,
        alt: row.alt_text,
        // The site renders this as the hover pill and it has always been the
        // display label, not the slug.
        style: styleLabel(row.style),
        placement: row.placement || null,
        caption: row.caption || null,
        featured: row.featured,
      });
    }

    // A CDN-friendly window: portfolios change a few times a week at most, and
    // the site revalidates on its own schedule anyway.
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    return res.json({ success: true, artists: byArtist });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    console.error(`❌ [TattooPortfolio] public read failed: ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: "Could not load portfolios" });
  }
});

// Mirrors tattoo_tag_taxonomy's `label`. Kept here so the public payload doesn't
// need a join on every request.
const STYLE_LABELS = {
  realism: "Realism",
  "fine-line": "Fine Line",
  "black-and-grey": "Black & Grey",
  color: "Color",
  traditional: "Traditional",
  lettering: "Lettering",
  geometric: "Geometric",
  floral: "Floral",
  "cover-up": "Cover-Up",
};
const styleLabel = (slug) =>
  STYLE_LABELS[slug] || String(slug || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ── Auth (everything below) ───────────────────────────────────────────────

router.use(express.json({ limit: "256kb" }));

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

/** Verify the caller's app session with its own auth server. Unforgeable. */
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
 * Token → app user → tattoo artist row. Matched on email, falling back to the
 * GHL user id on the app's own profile for anyone whose shop email differs from
 * their login.
 *
 * Only the three artists seeded into tattoo_artists resolve. Claudia (a test
 * account) and Kaelani (left the studio) deliberately have no row, so neither
 * can put work on the public site.
 */
async function resolveArtist(req, _res, next) {
  try {
    if (!supabase) throw new HttpError(503, "Storage not configured");

    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "Missing session token");

    const appUser = await verifyAppUser(token);
    const email = String(appUser.email || "").toLowerCase();

    let ghlUserId = null;
    try {
      const { data } = await supabase
        .from("profiles")
        .select("ghl_user_id")
        .eq("id", appUser.id)
        .maybeSingle();
      ghlUserId = data?.ghl_user_id || null;
    } catch {
      /* email match alone is usually enough */
    }

    let artist = null;
    if (email) {
      const { data } = await supabase
        .from("tattoo_artists")
        .select("*")
        .eq("email", email)
        .maybeSingle();
      artist = data || null;
    }
    if (!artist && ghlUserId) {
      const { data } = await supabase
        .from("tattoo_artists")
        .select("*")
        .eq("ghl_user_id", ghlUserId)
        .maybeSingle();
      artist = data || null;
    }

    if (!artist || artist.active === false) throw new HttpError(403, "NO_CHAIR");

    req.artist = artist;
    next();
  } catch (error) {
    next(error);
  }
}

router.use(requireInternalKey);
router.use(resolveArtist);

const shapeArtist = (a) => ({
  artistId: a.id,
  slug: a.slug,
  firstName: a.first_name,
  fullName: a.full_name,
});

const handle = (what, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    console.error(`❌ [TattooPortfolio] ${what} failed: ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: `Couldn't ${what}.` });
  }
};

/** The artist's GHL media folder, created on first upload. */
async function folderFor(artist) {
  if (artist.ghl_media_folder_id) return artist.ghl_media_folder_id;
  const folderId = await pipeline.ensureFolder(artist.slug);
  if (folderId) {
    await supabase.from("tattoo_artists").update({ ghl_media_folder_id: folderId }).eq("id", artist.id);
  }
  // A null folder is survivable — GHL drops the file in the location root.
  return folderId;
}

// ── Reads ─────────────────────────────────────────────────────────────────

router.get(
  "/me",
  handle("load your account", async (req, res) => {
    res.json({ success: true, artist: shapeArtist(req.artist) });
  })
);

router.get(
  "/taxonomy",
  handle("load the tags", async (_req, res) => {
    const { data, error } = await supabase
      .from("tattoo_tag_taxonomy")
      .select("*")
      .eq("active", true)
      .order("display_order", { ascending: true });
    if (error) throw new HttpError(502, error.message);
    res.json({ success: true, taxonomy: data || [] });
  })
);

router.get(
  "/photos",
  handle("load your portfolio", async (req, res) => {
    const { data, error } = await supabase
      .from("tattoo_portfolio_photos")
      .select(PHOTO_COLUMNS)
      .eq("artist_id", req.artist.id)
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
    const style = String(req.body.style || "");
    const placement = String(req.body.placement || "");
    if (!style) throw new HttpError(400, "Pick a style.");
    if (!placement) throw new HttpError(400, "Pick a placement.");

    const folderId = await folderFor(req.artist);
    const caption = String(req.body.caption || "").trim();

    const processed = await pipeline.processUpload({
      buffer: req.file?.buffer,
      artistName: req.artist.full_name,
      firstName: req.artist.first_name,
      folderId,
      style,
      placement,
      caption,
    });

    const { data, error } = await supabase
      .from("tattoo_portfolio_photos")
      .insert({
        artist_id: req.artist.id, // from the verified session, never the body
        style,
        placement,
        alt_text: processed.altText,
        seo_filename: processed.seoFilename,
        caption: caption || null,
        width: processed.width,
        height: processed.height,
        ghl_file_id: processed.ghlFileId,
        url: processed.url,
      })
      .select(PHOTO_COLUMNS)
      .single();

    if (error || !data) {
      pipeline.deleteGhlFile(processed.ghlFileId).catch(() => {});
      throw new HttpError(502, error?.message || "The photo uploaded but didn't save.");
    }
    res.json({ success: true, photo: data });
  })
);

// ── Edits ─────────────────────────────────────────────────────────────────

async function ownedPhoto(artistId, photoId) {
  const { data } = await supabase
    .from("tattoo_portfolio_photos")
    .select("*")
    .eq("id", photoId)
    .eq("artist_id", artistId)
    .maybeSingle();
  if (!data) throw new HttpError(404, "Photo not found");
  return data;
}

router.patch(
  "/photos/:id",
  handle("save that change", async (req, res) => {
    const photo = await ownedPhoto(req.artist.id, req.params.id);
    const body = req.body || {};

    // Allow-list, so a stray field can't rewrite url, ghl_file_id or artist_id.
    const patch = {};
    if (typeof body.featured === "boolean") patch.featured = body.featured;
    if (Number.isInteger(body.sortOrder)) patch.sort_order = body.sortOrder;
    if (typeof body.style === "string" && body.style) patch.style = body.style;
    if (typeof body.placement === "string" && body.placement) patch.placement = body.placement;
    if ("caption" in body) {
      const caption = String(body.caption ?? "").trim();
      patch.caption = caption || null;
    }

    // Style, placement and caption all feed the alt text, so it is rebuilt
    // whenever any of them moves — otherwise a retagged photo keeps describing
    // itself as the thing it used to be.
    if (patch.style || patch.placement || "caption" in body) {
      patch.alt_text = pipeline.buildAltText({
        artistName: req.artist.full_name,
        style: patch.style ?? photo.style,
        placement: patch.placement ?? photo.placement,
        caption: "caption" in body ? patch.caption : photo.caption,
      });
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to save");

    const { data, error } = await supabase
      .from("tattoo_portfolio_photos")
      .update(patch)
      .eq("id", photo.id)
      .eq("artist_id", req.artist.id)
      .select(PHOTO_COLUMNS)
      .single();
    if (error || !data) throw new HttpError(502, error?.message || "Couldn't save that change.");
    res.json({ success: true, photo: data });
  })
);

/** The whole wall in one request, so a dropped connection can't half-write it. */
router.patch(
  "/photos",
  handle("save your order", async (req, res) => {
    const order = req.body?.order;
    if (!Array.isArray(order) || order.length === 0) throw new HttpError(400, "order is required");
    if (order.length > 300) throw new HttpError(400, "Too many photos in one save");

    const ids = order.map((row) => String(row.id));
    const { data: owned, error: ownErr } = await supabase
      .from("tattoo_portfolio_photos")
      .select("id")
      .eq("artist_id", req.artist.id)
      .in("id", ids);
    if (ownErr) throw new HttpError(502, ownErr.message);
    if ((owned || []).length !== ids.length) throw new HttpError(404, "Some photos aren't yours");

    for (const row of order) {
      if (!Number.isInteger(row.sortOrder)) throw new HttpError(400, "sortOrder must be an integer");
      const { error } = await supabase
        .from("tattoo_portfolio_photos")
        .update({ sort_order: row.sortOrder })
        .eq("id", String(row.id))
        .eq("artist_id", req.artist.id);
      if (error) throw new HttpError(502, error.message);
    }
    res.json({ success: true });
  })
);

router.post(
  "/photos/:id/recrop",
  handle("save the new crop", async (req, res) => {
    const photo = await ownedPhoto(req.artist.id, req.params.id);
    const folderId = await folderFor(req.artist);

    const processed = await pipeline.processRecrop({
      sourceUrl: photo.url,
      folderId,
      seoFilename: photo.seo_filename,
      crop: req.body?.crop,
    });

    const { data, error } = await supabase
      .from("tattoo_portfolio_photos")
      .update({
        url: processed.url,
        ghl_file_id: processed.ghlFileId,
        width: processed.width,
        height: processed.height,
      })
      .eq("id", photo.id)
      .eq("artist_id", req.artist.id)
      .select(PHOTO_COLUMNS)
      .single();

    if (error || !data) {
      pipeline.deleteGhlFile(processed.ghlFileId).catch(() => {});
      throw new HttpError(502, error?.message || "Couldn't save the new crop.");
    }
    // Legacy rows migrated off the hardcoded array have no fileId; nothing to drop.
    if (photo.ghl_file_id && photo.ghl_file_id !== processed.ghlFileId) {
      pipeline.deleteGhlFile(photo.ghl_file_id).catch(() => {});
    }
    res.json({ success: true, photo: data });
  })
);

router.delete(
  "/photos/:id",
  handle("delete that photo", async (req, res) => {
    const photo = await ownedPhoto(req.artist.id, req.params.id);

    // Bytes first, so a failure leaves a retryable row rather than a row
    // pointing at nothing. Legacy rows carry no fileId and skip straight past.
    await pipeline.deleteGhlFile(photo.ghl_file_id);

    const { error } = await supabase
      .from("tattoo_portfolio_photos")
      .delete()
      .eq("id", photo.id)
      .eq("artist_id", req.artist.id);
    if (error) throw new HttpError(502, error.message);
    res.json({ success: true });
  })
);

router.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }
  console.error(`❌ [TattooPortfolio] unhandled: ${error?.message?.slice(0, 200)}`);
  return res.status(500).json({ success: false, error: "Something went wrong." });
});

module.exports = router;
