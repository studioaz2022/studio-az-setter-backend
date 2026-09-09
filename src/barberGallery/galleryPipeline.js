// galleryPipeline.js — the barber gallery's image pipeline, shared.
//
// Extracted from barberGalleryRoutes.js so the web uploader and the iOS app run
// the SAME pipeline. The SEO filename and alt-text builders in particular must
// never fork: alt_text is the live image-SEO lever (the served GHL URL is a
// random UUID, so the keyword filename is NOT a ranking signal on its own), and
// two implementations would quietly drift apart.
//
// Every operation throws HttpError(status, message) instead of touching res, so
// both an Express handler and another service can call them.
//
// GHL upload gotcha (verified Phase 0): the SDK's axios forces application/json,
// so multipart MUST use the form-data package with { headers: fd.getHeaders() }.

const sharp = require("sharp");
const FormData = require("form-data");
const crypto = require("crypto");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

// Hosts we will fetch live gallery masters from for reframe. Reject anything else
// so this can't be used as an open proxy.
const REFRAME_URL_HOSTS = new Set(["assets.cdn.filesafe.space"]);
const MIN_CROP_EDGE = 400; // short side; website cards never need less

function requireSdk() {
  if (!ghlBarber) throw new HttpError(503, "Barber GHL SDK not configured");
}

async function uploadToGhl(buffer, filename, ghlFolderId) {
  const fd = new FormData();
  fd.append("file", buffer, { filename, contentType: "image/webp" });
  fd.append("name", filename);
  fd.append("parentId", ghlFolderId);
  const uploaded = await ghlBarber.medias.uploadMediaContent(fd, { headers: fd.getHeaders() });
  if (!uploaded?.url || !uploaded?.fileId) {
    throw new HttpError(502, "GHL upload returned no url/fileId");
  }
  return uploaded;
}

/**
 * Decode → auto-orient → normalize to 4:5 (1280x1600, cover) → WebP q80 (EXIF
 * stripped) → SEO filename + alt text → upload to the barber's GHL folder.
 *
 * Stores BYTES ONLY. The metadata row is written by the caller, because who is
 * allowed to write it differs: the web uploader inserts as the signed-in barber
 * under RLS, the app inserts through the backend after verifying their session.
 */
async function processUpload({ buffer, barberSlug, barberFirst, ghlFolderId, cutPillar, tags }) {
  requireSdk();
  if (!buffer?.length) throw new HttpError(400, "file is required");
  if (!barberSlug || !barberFirst || !ghlFolderId) {
    throw new HttpError(400, "barberSlug, barberFirst, ghlFolderId are required");
  }
  if (!PILLARS.has(cutPillar)) {
    throw new HttpError(400, "cutPillar must be one of fade|classic-cut|long-hair|afro");
  }
  if (!Array.isArray(tags) || !tags.includes(cutPillar)) {
    throw new HttpError(400, "tags must be an array containing cutPillar");
  }

  let processed;
  try {
    processed = await sharp(buffer)
      .rotate() // honor EXIF orientation before stripping it
      .resize(OUT_WIDTH, OUT_HEIGHT, { fit: "cover", position: "attention" })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch (e) {
    throw new HttpError(
      415,
      `Could not decode image (${e.message?.slice(0, 80)}). Upload a JPEG, PNG, or WebP.`
    );
  }

  const seoFilename = buildSeoFilename({ first: barberFirst, cutPillar, tags });
  const altText = buildAltText({ first: barberFirst, cutPillar, tags });
  const uploaded = await uploadToGhl(processed, seoFilename, ghlFolderId);

  console.log(
    `📸 [BarberGallery] ${barberSlug} uploaded ${seoFilename} (${processed.length} bytes) → ${uploaded.fileId}`
  );
  return {
    ghlFileId: uploaded.fileId,
    url: uploaded.url,
    width: OUT_WIDTH,
    height: OUT_HEIGHT,
    seoFilename,
    altText,
    bytes: processed.length,
  };
}

/**
 * Fetch the live WebP, extract a 4:5 window in SOURCE pixels (no upscale),
 * re-encode WebP q80 once, upload a new GHL file.
 *
 * Does NOT delete the old file: the caller repoints its row first, then deletes,
 * so a failure anywhere leaves the row pointing at something that exists.
 * SEO filename is reused as-is — tags and alt don't change on a reframe.
 */
async function processRecrop({ sourceUrl, ghlFolderId, seoFilename, crop }) {
  requireSdk();
  if (!sourceUrl || !ghlFolderId || !seoFilename || !crop) {
    throw new HttpError(400, "sourceUrl, ghlFolderId, seoFilename, and crop are required");
  }

  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new HttpError(400, "sourceUrl is not a valid URL");
  }
  if (parsed.protocol !== "https:" || !REFRAME_URL_HOSTS.has(parsed.hostname)) {
    throw new HttpError(400, "sourceUrl host is not allowed");
  }

  const left = Math.round(Number(crop.left));
  const top = Math.round(Number(crop.top));
  let width = Math.round(Number(crop.width));
  let height = Math.round(Number(crop.height));
  if (![left, top, width, height].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new HttpError(400, "crop must be non-negative numbers");
  }
  if (width < MIN_CROP_EDGE || height < MIN_CROP_EDGE) {
    throw new HttpError(400, `Crop too tight — keep at least ${MIN_CROP_EDGE}px on each side.`);
  }
  // WebP encode is happier with even dims; trim 1px if needed (still ~4:5).
  if (width % 2 === 1) width -= 1;
  if (height % 2 === 1) height -= 1;

  if (Math.abs(width / height - 4 / 5) > 0.02) {
    throw new HttpError(400, "crop must be 4:5 portrait");
  }

  let sourceBuf;
  try {
    const upstream = await fetch(sourceUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!upstream.ok) throw new HttpError(502, `Could not fetch source (${upstream.status})`);
    if (Number(upstream.headers.get("content-length") || 0) > 20 * 1024 * 1024) {
      throw new HttpError(413, "Source image too large");
    }
    sourceBuf = Buffer.from(await upstream.arrayBuffer());
    if (sourceBuf.length > 20 * 1024 * 1024) throw new HttpError(413, "Source image too large");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Could not fetch source (${e.message?.slice(0, 80) || "network error"})`);
  }

  let processed;
  try {
    const meta = await sharp(sourceBuf).metadata();
    const srcW = meta.width || 0;
    const srcH = meta.height || 0;
    if (!srcW || !srcH) throw new HttpError(415, "Could not read source dimensions");
    if (left + width > srcW || top + height > srcH) {
      throw new HttpError(400, `crop is outside the source (${srcW}x${srcH})`);
    }
    // Decode → extract → WebP. No resize/upscale — keep the real pixel window.
    processed = await sharp(sourceBuf)
      .extract({ left, top, width, height })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(415, `Could not crop image (${e.message?.slice(0, 80)}).`);
  }

  const safeName = String(seoFilename).replace(/[^a-zA-Z0-9._-]/g, "") || "reframe.webp";
  const uploaded = await uploadToGhl(processed, safeName, ghlFolderId);

  console.log(
    `✂️ [BarberGallery] recrop ${safeName} → ${width}x${height} (${processed.length} bytes) fileId=${uploaded.fileId}`
  );
  return {
    ghlFileId: uploaded.fileId,
    url: uploaded.url,
    width,
    height,
    bytes: processed.length,
  };
}

/** Remove a photo's bytes from GHL. */
async function deleteGhlFile(id) {
  requireSdk();
  await ghlBarber.medias.deleteMediaContent({
    id,
    altType: "location",
    altId: process.env.GHL_BARBER_LOCATION_ID,
  });
}

module.exports = {
  HttpError,
  PILLARS,
  processUpload,
  processRecrop,
  deleteGhlFile,
  buildAltText,
  buildSeoFilename,
};
