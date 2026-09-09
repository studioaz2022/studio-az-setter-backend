// tattooPipeline.js — the tattoo portfolio's image pipeline.
//
// Deliberately a sibling of galleryPipeline.js rather than a shared abstraction.
// The mechanical part (sharp → 4:5 WebP → GHL upload) is thirty lines and is
// duplicated on purpose; the part that actually carries meaning — the alt text
// and SEO filename — is genuinely DIFFERENT per brand and must never be forced
// into one shape:
//
//   barbershop: "Taper fade with textured fringe by Lionel, barber at Studio AZ
//                Barbershop in Minneapolis."
//   tattoo:     "Fine line tattoo on forearm by Joan Martinez at Studio AZ
//                Tattoo Minneapolis."
//
// The tattoo wording matches the alt text already hand-written on the live site
// (see the 14 migrated rows), so a photo uploaded through the app is
// indistinguishable from one Lionel added by hand.
//
// Alt text stays ENGLISH even though the artist-facing UI is bilingual: it
// targets English search in the Minneapolis market, and that is what every
// existing image on the site does.

const sharp = require("sharp");
const FormData = require("form-data");
const crypto = require("crypto");
const { ghlTattoo } = require("../clients/ghlMultiLocationSdk");
const { HttpError } = require("./galleryPipeline");

const OUT_WIDTH = 1280;
const OUT_HEIGHT = 1600; // 4:5 portrait — matches both grids on the site
const WEBP_QUALITY = 80;
const MIN_CROP_EDGE = 400;
const REFRAME_URL_HOSTS = new Set(["assets.cdn.filesafe.space"]);

// Labels for copy. Mirrors tattoo_tag_taxonomy; unknown slugs fall back to
// de-hyphenated lower case so taxonomy rows added later still read sanely
// without a backend deploy.
const STYLE_LABELS = {
  realism: "Realism",
  "fine-line": "Fine line",
  portrait: "Portrait",
  religious: "Religious",
  traditional: "Traditional",
  lettering: "Lettering",
  geometric: "Geometric",
  floral: "Floral",
  polynesian: "Polynesian",
  "cover-up": "Cover-up",
};

// Styles whose label is a proper adjective and keeps its capital wherever it
// lands in a sentence. Everything else lowercases when something precedes it,
// so we get "Black and grey realism tattoo" but "Black and grey Polynesian
// half sleeve tattoo" — which is exactly how the hand-written originals read.
const PROPER_STYLES = new Set(["polynesian"]);

// Ink is its own axis: it says how a piece is inked, not what it is. Only black
// and grey is ever stated in copy — the originals never write "color tattoo",
// because colour is the unmarked case.
const INK_LEAD = { "black-and-grey": "Black and grey" };

const PLACEMENT_LABELS = {
  forearm: "forearm",
  "upper-arm": "upper arm",
  "full-sleeve": "sleeve",
  "half-sleeve": "half sleeve",
  back: "back",
  chest: "chest",
  ribs: "ribs",
  stomach: "stomach",
  leg: "leg",
  hand: "hand",
  neck: "neck",
};

const deSlug = (slug) => String(slug).replace(/-/g, " ").toLowerCase();
const styleLabel = (slug) => STYLE_LABELS[slug] || deSlug(slug);
const placementLabel = (slug) => PLACEMENT_LABELS[slug] || deSlug(slug);

/**
 * "Fine line floral tattoo on forearm by Joan Martinez at Studio AZ Tattoo
 * Minneapolis." — the subject comes from the artist's own caption when they
 * wrote one, which is what makes these read like the hand-written originals
 * rather than a template.
 */
function buildAltText({ artistName, style, placement, ink, caption }) {
  const subject = String(caption || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

  // Sleeves read as an adjective ("tiger mountain sleeve tattoo"); body parts
  // read as a location ("tattoo on forearm"). The hand-written originals do
  // both, each where it sounds right, so this follows them.
  const adjectival = placement === "full-sleeve" || placement === "half-sleeve";
  const inkLead = INK_LEAD[ink] || null;
  const styleWord = inkLead && !PROPER_STYLES.has(style)
    ? styleLabel(style).toLowerCase()
    : styleLabel(style);
  const lead = [
    inkLead,
    styleWord,
    subject,
    adjectival ? placementLabel(placement) : null,
    "tattoo",
  ].filter(Boolean).join(" ");
  const where = placement && !adjectival ? ` on ${placementLabel(placement)}` : "";
  return `${lead}${where} by ${artistName} at Studio AZ Tattoo Minneapolis`;
}

/** "joan-fine-line-floral-forearm-minneapolis-a1b2c3.webp" */
function buildSeoFilename({ firstName, style, placement, ink, caption }) {
  const subject = String(caption || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join("-");

  const shortId = crypto.randomBytes(3).toString("hex");
  return (
    [firstName.toLowerCase(), ink === "black-and-grey" ? ink : null, style, subject, placement, "minneapolis", shortId]
      .filter(Boolean)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-{2,}/g, "-") + ".webp"
  );
}

function requireSdk() {
  if (!ghlTattoo) throw new HttpError(503, "Tattoo GHL SDK not configured");
}

async function uploadToGhl(buffer, filename, folderId) {
  const fd = new FormData();
  fd.append("file", buffer, { filename, contentType: "image/webp" });
  fd.append("name", filename);
  if (folderId) fd.append("parentId", folderId);
  // The SDK's axios forces application/json, so multipart MUST go through the
  // form-data package with its own headers.
  const uploaded = await ghlTattoo.medias.uploadMediaContent(fd, { headers: fd.getHeaders() });
  if (!uploaded?.url || !uploaded?.fileId) {
    throw new HttpError(502, "GHL upload returned no url/fileId");
  }
  return uploaded;
}

/**
 * Decode → auto-orient → normalise to 4:5 → WebP → SEO filename + alt text →
 * upload to the artist's GHL folder. Stores BYTES ONLY; the row is written by
 * the caller after the artist's session has been verified.
 */
async function processUpload({ buffer, artistName, firstName, folderId, style, placement, ink, caption }) {
  requireSdk();
  if (!buffer?.length) throw new HttpError(400, "file is required");
  if (!style) throw new HttpError(400, "Pick a style.");

  let processed;
  try {
    processed = await sharp(buffer)
      .rotate() // honour EXIF orientation before stripping it
      .resize(OUT_WIDTH, OUT_HEIGHT, { fit: "cover", position: "attention" })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch (e) {
    throw new HttpError(
      415,
      `Could not decode image (${e.message?.slice(0, 80)}). Upload a JPEG, PNG, or WebP.`
    );
  }

  const seoFilename = buildSeoFilename({ firstName, style, placement, ink, caption });
  const altText = buildAltText({ artistName, style, placement, ink, caption });
  const uploaded = await uploadToGhl(processed, seoFilename, folderId);

  console.log(
    `🖋️ [TattooPortfolio] ${firstName} uploaded ${seoFilename} (${processed.length} bytes) → ${uploaded.fileId}`
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
 * Trim a live WebP to a new 4:5 window in source pixels. No upscale — a soft
 * photo is worse than a loose one. Does NOT delete the old file; the caller
 * repoints the row first so a failure never leaves a row pointing at nothing.
 */
async function processRecrop({ sourceUrl, folderId, seoFilename, crop }) {
  requireSdk();
  if (!sourceUrl || !seoFilename || !crop) {
    throw new HttpError(400, "sourceUrl, seoFilename and crop are required");
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
  if (width % 2 === 1) width -= 1;
  if (height % 2 === 1) height -= 1;
  if (Math.abs(width / height - 4 / 5) > 0.02) {
    throw new HttpError(400, "crop must be 4:5 portrait");
  }

  let sourceBuf;
  try {
    const upstream = await fetch(sourceUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!upstream.ok) throw new HttpError(502, `Could not fetch source (${upstream.status})`);
    sourceBuf = Buffer.from(await upstream.arrayBuffer());
    if (sourceBuf.length > 20 * 1024 * 1024) throw new HttpError(413, "Source image too large");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Could not fetch source (${e.message?.slice(0, 80) || "network error"})`);
  }

  let processed;
  try {
    const meta = await sharp(sourceBuf).metadata();
    if (!meta.width || !meta.height) throw new HttpError(415, "Could not read source dimensions");
    if (left + width > meta.width || top + height > meta.height) {
      throw new HttpError(400, `crop is outside the source (${meta.width}x${meta.height})`);
    }
    processed = await sharp(sourceBuf)
      .extract({ left, top, width, height })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(415, `Could not crop image (${e.message?.slice(0, 80)}).`);
  }

  const safeName = String(seoFilename).replace(/[^a-zA-Z0-9._-]/g, "") || "reframe.webp";
  const uploaded = await uploadToGhl(processed, safeName, folderId);

  console.log(`✂️ [TattooPortfolio] recrop ${safeName} → ${width}x${height} fileId=${uploaded.fileId}`);
  return { ghlFileId: uploaded.fileId, url: uploaded.url, width, height };
}

/** Legacy rows migrated off the hardcoded array carry no fileId — nothing to delete. */
async function deleteGhlFile(id) {
  if (!id) return;
  requireSdk();
  await ghlTattoo.medias.deleteMediaContent({
    id,
    altType: "location",
    altId: process.env.GHL_LOCATION_ID, // the default location IS the tattoo shop
  });
}

/** One folder per artist in the tattoo location's media library, made on demand. */
async function ensureFolder(artistSlug) {
  requireSdk();
  const created = await ghlTattoo.medias.createMediaFolder({
    name: `portfolio-${artistSlug}`,
    altType: "location",
    altId: process.env.GHL_LOCATION_ID, // the default location IS the tattoo shop
  });
  // The SDK's type omits _id even though the response carries it.
  return created?._id || created?.id || created?.folder?._id || null;
}

module.exports = {
  processUpload,
  processRecrop,
  deleteGhlFile,
  ensureFolder,
  buildAltText,
  buildSeoFilename,
};
