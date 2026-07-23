// barberGalleryRoutes.js — Barber Gallery Uploader processing pipeline
// BARBER_GALLERY_UPLOADER_PLAN.md §5.2 (Phase 2)
//
// POST /api/barber-gallery/upload  (gated by x-internal-key)
//   multipart: file (image blob, client-cropped ~4:5)
//   fields:    barberSlug, barberFirst, ghlFolderId, cutPillar, tags (JSON array of slugs)
//   returns:   { success, ghlFileId, url, width, height, seoFilename, altText }
//
// POST /api/barber-gallery/recrop  (gated by x-internal-key)
//   JSON:      sourceUrl, ghlFolderId, seoFilename, crop { left, top, width, height }
//   returns:   { success, ghlFileId, url, width, height }
//   Trims the live WebP to a 4:5 window (no upscale). Uploader updates the row,
//   then DELETEs the previous GHL file. SEO/alt are not regenerated.
//
// Pipeline: auto-orient → normalize to 4:5 (1280x1600, cover) → WebP q80 (EXIF
// stripped by default) → SEO filename + auto alt-text → upload to the barber's
// GHL Media Library folder. Metadata row insert happens in the uploader app
// (RLS enforces barber ownership) — this endpoint only processes + stores bytes.
//
// GHL upload gotcha (verified Phase 0): the SDK's axios forces application/json,
// so multipart MUST use the form-data package with { headers: fd.getHeaders() }.

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const FormData = require("form-data");
const crypto = require("crypto");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }, // client canvas exports stay well under this
});

const OUT_WIDTH = 1280;
const OUT_HEIGHT = 1600; // 4:5 portrait
const WEBP_QUALITY = 80;

// Labels for alt-text / filenames. Mirrors gallery_tag_taxonomy seeds; unknown
// slugs fall back to de-hyphenated title case so taxonomy rows added later
// still produce sane text without a backend deploy.
const TAG_LABELS = {
  fade: "fade", "classic-cut": "classic cut", "long-hair": "long hair", afro: "afro",
  taper: "taper", "burst-fade": "burst fade", beard: "beard",
  texture: "textured top", "textured-fringe": "textured fringe", pompadour: "pompadour", "slick-back": "slick back",
  "middle-part": "middle part", "comb-over": "comb over", "wolf-cut": "wolf cut",
  "warrior-cut": "warrior cut", "blowout-taper": "blowout taper", "crop-top": "crop top",
  "two-block": "two block", quiff: "quiff", undercut: "undercut", "crew-cut": "crew cut",
  caesar: "caesar", "faux-hawk": "faux hawk", mullet: "mullet",
  "mod-cut": "mod cut", "brush-back": "brush back", "modern-mullet": "modern mullet", messy: "messy",
  straight: "straight hair", wavy: "wavy hair", "wavy-curly": "wavy-to-curly hair",
  curly: "curly hair", asian: "asian hair",
};
// Style slugs for alt-text/filename. NOTE: burst-fade is now a Fade cut sub-tag
// (handled in the pillar phrase), not a style.
const STYLE_SLUGS = new Set([
  "texture", "textured-fringe", "pompadour", "slick-back", "middle-part", "comb-over", "wolf-cut",
  "warrior-cut", "blowout-taper", "crop-top", "two-block", "quiff", "undercut",
  "crew-cut", "caesar", "faux-hawk", "mullet", "mod-cut", "brush-back", "modern-mullet", "messy",
]);
// Specific sub-tag → its generic parent. When the specific one is present we drop
// the parent from copy (avoids "mullet and modern mullet" / "textured and textured fringe").
const STYLE_PARENT = { "textured-fringe": "texture", "modern-mullet": "mullet" };
const PILLARS = new Set(["fade", "classic-cut", "long-hair", "afro"]);

// The Fade shape shown in copy: burst fade > taper > plain fade.
function fadePhrase(tags) {
  if (tags.includes("burst-fade")) return "Burst fade";
  if (tags.includes("taper")) return "Taper fade";
  return "Fade haircut";
}
function fadeSlug(tags) {
  if (tags.includes("burst-fade")) return "burst-fade";
  if (tags.includes("taper")) return "taper-fade";
  return "fade";
}
// Styles to show, with generic parents dropped when their specific child is
// present, and the "messy" modifier removed (it's folded in as a prefix later).
function displayStyles(tags) {
  const styles = tags.filter((t) => STYLE_SLUGS.has(t) && t !== "messy");
  const drop = new Set();
  for (const [child, parent] of Object.entries(STYLE_PARENT)) {
    if (styles.includes(child)) drop.add(parent);
  }
  return styles.filter((t) => !drop.has(t));
}

// High-search styles we want the site to rank for lead the alt text + filename,
// so they never lose to tap order (or get truncated out of the filename).
const HERO_STYLES = [
  "textured-fringe", "warrior-cut", "mod-cut", "modern-mullet", "mullet", "middle-part", "brush-back",
];
function orderedStyles(tags) {
  const styles = displayStyles(tags);
  const heroes = HERO_STYLES.filter((h) => styles.includes(h));
  return [...heroes, ...styles.filter((s) => !heroes.includes(s))];
}

const label = (slug) =>
  TAG_LABELS[slug] || String(slug).replace(/-/g, " ").toLowerCase();

// Ordered style tokens for copy, with "messy" folded in as a ONE-TIME prefix on
// the lead STYLE (never repeated → not keyword-stuffing). kind: "label" | "slug".
// When there's no style, messy attaches to the CUT instead (see messyOnCut).
function copyStyleTokens(tags, kind) {
  const toToken = kind === "label" ? label : (s) => s;
  const tokens = orderedStyles(tags).map(toToken);
  if (tags.includes("messy") && tokens.length) {
    tokens[0] = (kind === "label" ? "messy " : "messy-") + tokens[0];
  }
  return tokens;
}

// True when "messy" should prefix the cut phrase — i.e. no style to attach to,
// so "messy taper fade" rather than a dangling "messy".
function messyOnCut(tags) {
  return tags.includes("messy") && displayStyles(tags).length === 0;
}

// "Taper fade with textured fringe and undercut by Lionel, barber at Studio AZ
// Barbershop in Minneapolis." — English-only (barbershop side).
function buildAltText({ first, cutPillar, tags }) {
  let pillarPhrase =
    cutPillar === "fade"
      ? fadePhrase(tags)
      : cutPillar === "classic-cut"
        ? "Classic haircut"
        : cutPillar === "long-hair"
          ? "Long hair cut"
          : "Afro haircut";
  if (messyOnCut(tags)) pillarPhrase = "Messy " + pillarPhrase.toLowerCase();

  const styles = copyStyleTokens(tags, "label");
  const stylePhrase =
    styles.length === 0
      ? ""
      : ` with ${styles.length === 1 ? styles[0] : styles.slice(0, -1).join(", ") + " and " + styles[styles.length - 1]}`;

  const beardPhrase = tags.includes("beard") ? ", including beard work," : "";

  return `${pillarPhrase}${stylePhrase}${beardPhrase} by ${first}, barber at Studio AZ Barbershop in Minneapolis.`;
}

// "lionel-taper-fade-textured-fringe-blowout-taper-minneapolis-a1b2c3.webp"
function buildSeoFilename({ first, cutPillar, tags }) {
  let cutPart = cutPillar === "fade" ? fadeSlug(tags) : cutPillar;
  if (messyOnCut(tags)) cutPart = "messy-" + cutPart;
  // up to 3 style keywords (hero styles first, messy folded into the lead one)
  const styleParts = copyStyleTokens(tags, "slug").slice(0, 3);
  const shortId = crypto.randomBytes(3).toString("hex");
  const parts = [first.toLowerCase(), cutPart, ...styleParts, "minneapolis", shortId].filter(Boolean);
  return (
    parts
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-{2,}/g, "-") + ".webp"
  );
}

function makeRequireInternalKey() {
  return (req, res, next) => {
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) {
      return res.status(503).json({ success: false, error: "INTERNAL_API_KEY not configured on server" });
    }
    if (req.get("x-internal-key") !== expected) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  };
}

router.post("/upload", makeRequireInternalKey(), upload.single("file"), async (req, res) => {
  try {
    if (!ghlBarber) {
      return res.status(503).json({ success: false, error: "Barber GHL SDK not configured" });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ success: false, error: "file is required" });
    }

    const { barberSlug, barberFirst, ghlFolderId, cutPillar } = req.body;
    let tags;
    try {
      tags = JSON.parse(req.body.tags || "[]");
    } catch {
      return res.status(400).json({ success: false, error: "tags must be a JSON array" });
    }
    if (!barberSlug || !barberFirst || !ghlFolderId) {
      return res.status(400).json({ success: false, error: "barberSlug, barberFirst, ghlFolderId are required" });
    }
    if (!PILLARS.has(cutPillar)) {
      return res.status(400).json({ success: false, error: "cutPillar must be one of fade|classic-cut|long-hair|afro" });
    }
    if (!Array.isArray(tags) || !tags.includes(cutPillar)) {
      return res.status(400).json({ success: false, error: "tags must be an array containing cutPillar" });
    }

    // 1-2. Decode + auto-orient + normalize to 4:5 + WebP (EXIF stripped by default).
    // HEIC never reaches here (client crop step exports canvas JPEG/WebP — Phase 0
    // decision); anything sharp can't decode gets a clear 415.
    let processed;
    try {
      processed = await sharp(req.file.buffer)
        .rotate() // honor EXIF orientation before stripping it
        .resize(OUT_WIDTH, OUT_HEIGHT, { fit: "cover", position: "attention" })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch (e) {
      return res.status(415).json({
        success: false,
        error: `Could not decode image (${e.message?.slice(0, 80)}). Upload a JPEG, PNG, or WebP.`,
      });
    }

    // 3. SEO filename + alt text
    const seoFilename = buildSeoFilename({ first: barberFirst, cutPillar, tags });
    const altText = buildAltText({ first: barberFirst, cutPillar, tags });

    // 4. Upload to the barber's GHL folder (form-data pkg — see gotcha above)
    const fd = new FormData();
    fd.append("file", processed, { filename: seoFilename, contentType: "image/webp" });
    fd.append("name", seoFilename);
    fd.append("parentId", ghlFolderId);
    const uploaded = await ghlBarber.medias.uploadMediaContent(fd, { headers: fd.getHeaders() });
    if (!uploaded?.url || !uploaded?.fileId) {
      return res.status(502).json({ success: false, error: "GHL upload returned no url/fileId" });
    }

    console.log(`📸 [BarberGallery] ${barberSlug} uploaded ${seoFilename} (${processed.length} bytes) → ${uploaded.fileId}`);
    return res.json({
      success: true,
      ghlFileId: uploaded.fileId,
      url: uploaded.url,
      width: OUT_WIDTH,
      height: OUT_HEIGHT,
      seoFilename,
      altText,
      bytes: processed.length,
    });
  } catch (error) {
    // Never log error.config/headers — GHL SDK errors can carry the auth token.
    console.error(`❌ [BarberGallery] upload failed: status=${error?.response?.status} ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: "Upload processing failed" });
  }
});

// Hosts we will fetch live gallery masters from for reframe. Reject anything else
// so this endpoint can't be used as an open proxy.
const REFRAME_URL_HOSTS = new Set(["assets.cdn.filesafe.space"]);
const MIN_CROP_EDGE = 400; // short side; website cards never need less

/**
 * POST /api/barber-gallery/recrop
 * JSON: { sourceUrl, ghlFolderId, seoFilename, crop: { left, top, width, height } }
 *
 * Fetches the live WebP, extracts a 4:5 window in source pixels (no upscale),
 * re-encodes WebP q80 once, uploads a new GHL file. Does NOT delete the old
 * file — the uploader updates the Supabase row first, then DELETEs the old id.
 * SEO filename is reused as-is (tags/alt don't change on a reframe).
 */
router.post("/recrop", makeRequireInternalKey(), async (req, res) => {
  try {
    if (!ghlBarber) {
      return res.status(503).json({ success: false, error: "Barber GHL SDK not configured" });
    }

    const { sourceUrl, ghlFolderId, seoFilename, crop } = req.body || {};
    if (!sourceUrl || !ghlFolderId || !seoFilename || !crop) {
      return res.status(400).json({
        success: false,
        error: "sourceUrl, ghlFolderId, seoFilename, and crop are required",
      });
    }

    let parsed;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      return res.status(400).json({ success: false, error: "sourceUrl is not a valid URL" });
    }
    if (parsed.protocol !== "https:" || !REFRAME_URL_HOSTS.has(parsed.hostname)) {
      return res.status(400).json({ success: false, error: "sourceUrl host is not allowed" });
    }

    const left = Math.round(Number(crop.left));
    const top = Math.round(Number(crop.top));
    let width = Math.round(Number(crop.width));
    let height = Math.round(Number(crop.height));
    if (![left, top, width, height].every((n) => Number.isFinite(n) && n >= 0)) {
      return res.status(400).json({ success: false, error: "crop must be non-negative numbers" });
    }
    if (width < MIN_CROP_EDGE || height < MIN_CROP_EDGE) {
      return res.status(400).json({
        success: false,
        error: `Crop too tight — keep at least ${MIN_CROP_EDGE}px on each side.`,
      });
    }
    // WebP encode is happier with even dims; trim 1px if needed (still ~4:5).
    if (width % 2 === 1) width -= 1;
    if (height % 2 === 1) height -= 1;

    const ratio = width / height;
    if (Math.abs(ratio - 4 / 5) > 0.02) {
      return res.status(400).json({ success: false, error: "crop must be 4:5 portrait" });
    }

    let sourceBuf;
    try {
      const upstream = await fetch(sourceUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!upstream.ok) {
        return res.status(502).json({ success: false, error: `Could not fetch source (${upstream.status})` });
      }
      const len = Number(upstream.headers.get("content-length") || 0);
      if (len > 20 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: "Source image too large" });
      }
      sourceBuf = Buffer.from(await upstream.arrayBuffer());
      if (sourceBuf.length > 20 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: "Source image too large" });
      }
    } catch (e) {
      return res.status(502).json({
        success: false,
        error: `Could not fetch source (${e.message?.slice(0, 80) || "network error"})`,
      });
    }

    let processed;
    let outW;
    let outH;
    try {
      const meta = await sharp(sourceBuf).metadata();
      const srcW = meta.width || 0;
      const srcH = meta.height || 0;
      if (!srcW || !srcH) {
        return res.status(415).json({ success: false, error: "Could not read source dimensions" });
      }
      if (left + width > srcW || top + height > srcH) {
        return res.status(400).json({
          success: false,
          error: `crop is outside the source (${srcW}x${srcH})`,
        });
      }

      // Decode → extract → WebP. No resize/upscale — keep the real pixel window.
      processed = await sharp(sourceBuf)
        .extract({ left, top, width, height })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      outW = width;
      outH = height;
    } catch (e) {
      return res.status(415).json({
        success: false,
        error: `Could not crop image (${e.message?.slice(0, 80)}).`,
      });
    }

    const safeName = String(seoFilename).replace(/[^a-zA-Z0-9._-]/g, "") || "reframe.webp";
    const fd = new FormData();
    fd.append("file", processed, { filename: safeName, contentType: "image/webp" });
    fd.append("name", safeName);
    fd.append("parentId", ghlFolderId);
    const uploaded = await ghlBarber.medias.uploadMediaContent(fd, { headers: fd.getHeaders() });
    if (!uploaded?.url || !uploaded?.fileId) {
      return res.status(502).json({ success: false, error: "GHL upload returned no url/fileId" });
    }

    console.log(
      `✂️ [BarberGallery] recrop ${safeName} → ${outW}x${outH} (${processed.length} bytes) fileId=${uploaded.fileId}`
    );
    return res.json({
      success: true,
      ghlFileId: uploaded.fileId,
      url: uploaded.url,
      width: outW,
      height: outH,
      bytes: processed.length,
    });
  } catch (error) {
    console.error(
      `❌ [BarberGallery] recrop failed: status=${error?.response?.status} ${error.message?.slice(0, 200)}`
    );
    return res.status(500).json({ success: false, error: "Recrop processing failed" });
  }
});

// DELETE /api/barber-gallery/file/:id — remove a photo's bytes from GHL when the
// barber deletes it in the uploader (row delete happens client-side under RLS).
router.delete("/file/:id", makeRequireInternalKey(), async (req, res) => {
  try {
    if (!ghlBarber) {
      return res.status(503).json({ success: false, error: "Barber GHL SDK not configured" });
    }
    await ghlBarber.medias.deleteMediaContent({
      id: req.params.id,
      altType: "location",
      altId: process.env.GHL_BARBER_LOCATION_ID,
    });
    return res.json({ success: true });
  } catch (error) {
    console.error(`❌ [BarberGallery] delete failed: status=${error?.response?.status} ${error.message?.slice(0, 200)}`);
    return res.status(500).json({ success: false, error: "Delete failed" });
  }
});

module.exports = router;
