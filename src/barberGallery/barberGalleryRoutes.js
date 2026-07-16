// barberGalleryRoutes.js — Barber Gallery Uploader processing pipeline
// BARBER_GALLERY_UPLOADER_PLAN.md §5.2 (Phase 2)
//
// POST /api/barber-gallery/upload  (gated by x-internal-key)
//   multipart: file (image blob, client-cropped ~4:5)
//   fields:    barberSlug, barberFirst, ghlFolderId, cutPillar, tags (JSON array of slugs)
//   returns:   { success, ghlFileId, url, width, height, seoFilename, altText }
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
  straight: "straight hair", wavy: "wavy hair", "wavy-curly": "wavy-to-curly hair",
  curly: "curly hair", asian: "asian hair",
};
// Style slugs for alt-text/filename. NOTE: burst-fade is now a Fade cut sub-tag
// (handled in the pillar phrase), not a style.
const STYLE_SLUGS = new Set([
  "texture", "textured-fringe", "pompadour", "slick-back", "middle-part", "comb-over", "wolf-cut",
  "warrior-cut", "blowout-taper", "crop-top", "two-block", "quiff", "undercut",
  "crew-cut", "caesar", "faux-hawk", "mullet",
]);
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
// If a photo carries both "texture" and the specific "textured-fringe", show
// only the specific one so the copy doesn't say "textured and textured fringe".
function displayStyles(tags) {
  const styles = tags.filter((t) => STYLE_SLUGS.has(t));
  return styles.includes("textured-fringe") ? styles.filter((t) => t !== "texture") : styles;
}

// High-search styles we want the site to rank for lead the alt text + filename,
// so they never lose to tap order (or get truncated out of the filename).
const HERO_STYLES = ["textured-fringe"];
function orderedStyles(tags) {
  const styles = displayStyles(tags);
  const heroes = HERO_STYLES.filter((h) => styles.includes(h));
  return [...heroes, ...styles.filter((s) => !heroes.includes(s))];
}

const label = (slug) =>
  TAG_LABELS[slug] || String(slug).replace(/-/g, " ").toLowerCase();

// "Taper fade with textured fringe and undercut by Lionel, barber at Studio AZ
// Barbershop in Minneapolis." — English-only (barbershop side).
function buildAltText({ first, cutPillar, tags }) {
  const pillarPhrase =
    cutPillar === "fade"
      ? fadePhrase(tags)
      : cutPillar === "classic-cut"
        ? "Classic haircut"
        : cutPillar === "long-hair"
          ? "Long hair cut"
          : "Afro haircut";

  const styles = orderedStyles(tags).map(label);
  const stylePhrase =
    styles.length === 0
      ? ""
      : ` with ${styles.length === 1 ? styles[0] : styles.slice(0, -1).join(", ") + " and " + styles[styles.length - 1]}`;

  const beardPhrase = tags.includes("beard") ? ", including beard work," : "";

  return `${pillarPhrase}${stylePhrase}${beardPhrase} by ${first}, barber at Studio AZ Barbershop in Minneapolis.`;
}

// "lionel-taper-fade-textured-fringe-blowout-taper-minneapolis-a1b2c3.webp"
function buildSeoFilename({ first, cutPillar, tags }) {
  const cutPart = cutPillar === "fade" ? fadeSlug(tags) : cutPillar;
  // up to 3 style keywords (hero styles first) — richer keywords, never drops textured-fringe
  const styleParts = orderedStyles(tags).slice(0, 3);
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
