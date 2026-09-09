// barberGalleryRoutes.js — Barber Gallery Uploader processing endpoints
// BARBER_GALLERY_UPLOADER_PLAN.md §5.2 (Phase 2)
//
// These serve the WEB uploader (barber-uploader.vercel.app), which holds its own
// Supabase session and writes the metadata row itself under RLS. They handle
// bytes only.
//
// The iOS app does NOT use these — it has no gallery session to write a row
// with, so it goes through /api/gallery-app, which verifies the barber's Studio
// AZ App session and writes the row server-side. Both paths run the SAME image
// pipeline (galleryPipeline.js); only who is trusted to write the row differs.
//
// POST /api/barber-gallery/upload  (gated by x-internal-key)
//   multipart: file (image blob, client-cropped ~4:5)
//   fields:    barberSlug, barberFirst, ghlFolderId, cutPillar, tags (JSON array of slugs)
//   returns:   { success, ghlFileId, url, width, height, seoFilename, altText }
//
// POST /api/barber-gallery/recrop  (gated by x-internal-key)
//   JSON:      sourceUrl, ghlFolderId, seoFilename, crop { left, top, width, height }
//   returns:   { success, ghlFileId, url, width, height }
//
// DELETE /api/barber-gallery/file/:id  (gated by x-internal-key)

const express = require("express");
const multer = require("multer");
const { HttpError, processUpload, processRecrop, deleteGhlFile } = require("./galleryPipeline");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }, // client canvas exports stay well under this
});

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

/** Pipeline errors carry their own status; anything else is a 500 with no detail.
 *  Never log error.config/headers — GHL SDK errors can carry the auth token. */
function fail(res, error, what) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ success: false, error: error.message });
  }
  console.error(
    `❌ [BarberGallery] ${what} failed: status=${error?.response?.status} ${error.message?.slice(0, 200)}`
  );
  return res.status(500).json({ success: false, error: `${what} processing failed` });
}

router.post("/upload", makeRequireInternalKey(), upload.single("file"), async (req, res) => {
  try {
    let tags;
    try {
      tags = JSON.parse(req.body.tags || "[]");
    } catch {
      return res.status(400).json({ success: false, error: "tags must be a JSON array" });
    }
    const result = await processUpload({
      buffer: req.file?.buffer,
      barberSlug: req.body.barberSlug,
      barberFirst: req.body.barberFirst,
      ghlFolderId: req.body.ghlFolderId,
      cutPillar: req.body.cutPillar,
      tags,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, "Upload");
  }
});

router.post("/recrop", makeRequireInternalKey(), async (req, res) => {
  try {
    const { sourceUrl, ghlFolderId, seoFilename, crop } = req.body || {};
    const result = await processRecrop({ sourceUrl, ghlFolderId, seoFilename, crop });
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, "Recrop");
  }
});

// Remove a photo's bytes from GHL when the barber deletes it in the web uploader
// (the row delete happens client-side under RLS).
router.delete("/file/:id", makeRequireInternalKey(), async (req, res) => {
  try {
    await deleteGhlFile(req.params.id);
    return res.json({ success: true });
  } catch (error) {
    return fail(res, error, "Delete");
  }
});

module.exports = router;
module.exports.makeRequireInternalKey = makeRequireInternalKey;
