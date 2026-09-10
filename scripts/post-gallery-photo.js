#!/usr/bin/env node
// post-gallery-photo — put a photo in a barber's book from the command line.
//
// Does exactly what the uploader's /api/upload route does, in the same order:
// send the cropped JPEG to the backend pipeline (sharp → 4:5 WebP → SEO filename
// + alt text → GHL), then write the gallery_photos row. If the row write fails
// the freshly uploaded GHL file is deleted, so bytes never accumulate with
// nothing pointing at them.
//
// The image must already be cropped to 4:5 — the pipeline normalises with
// fit:cover, so handing it an uncropped photo silently centre-crops it and
// throws away the framing decision. Use tools/ovalcrop.swift first.
//
// Usage:
//   node scripts/post-gallery-photo.js \
//     --barber joshua --file crop.jpg \
//     --pillar classic-cut --tags brush-back,middle-part,asian \
//     [--caption "..."] [--sort 0] [--dry]

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const BACKEND = process.env.BACKEND_URL || "https://studio-az-setter-backend.onrender.com";
const KEY = process.env.INTERNAL_API_KEY;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const barberSlug = arg("barber");
const file = arg("file");
const pillar = arg("pillar");
const extraTags = (arg("tags") || "").split(",").map((t) => t.trim()).filter(Boolean);
const caption = arg("caption", "");
const sortOrder = arg("sort") === null ? null : Number(arg("sort"));
const dry = flag("dry");

if (!barberSlug || !file || !pillar) {
  console.error("need --barber, --file and --pillar");
    process.exit(1);
}

const gallery = createClient(
  process.env.GALLERY_SUPABASE_URL,
  process.env.GALLERY_SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

(async () => {
  const { data: barber, error: barberErr } = await gallery
    .from("barbers")
    .select("id, slug, first_name, ghl_media_folder_id")
    .eq("slug", barberSlug)
    .single();
  if (barberErr || !barber) throw new Error(`no barber "${barberSlug}"`);
  if (!barber.ghl_media_folder_id) throw new Error(`${barberSlug} has no media folder`);

  // The pillar has to be in tags[] — the backend rejects the upload otherwise,
  // and the DB check constraint would reject the row after that.
  const tags = [pillar, ...extraTags.filter((t) => t !== pillar)];

  console.log(`  barber : ${barber.first_name} (${barber.slug})`);
  console.log(`  file   : ${path.basename(file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  console.log(`  pillar : ${pillar}`);
  console.log(`  tags   : ${tags.join(", ")}`);
  if (caption) console.log(`  caption: ${caption}`);
  if (dry) return console.log("\n  --dry, stopping before upload");

  // 1. Pixels through the pipeline.
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type: "image/jpeg" }), "crop.jpg");
  form.append("barberSlug", barber.slug);
  form.append("barberFirst", barber.first_name);
  form.append("ghlFolderId", barber.ghl_media_folder_id);
  form.append("cutPillar", pillar);
  form.append("tags", JSON.stringify(tags));

  const res = await fetch(`${BACKEND}/api/barber-gallery/upload`, {
    method: "POST",
    headers: { "x-internal-key": KEY },
    body: form,
  });
  const processed = await res.json();
  if (!res.ok || !processed.success) {
    throw new Error(`pipeline: ${processed.error || res.status}`);
  }
  console.log(`\n  alt    : ${processed.altText}`);
  console.log(`  file   : ${processed.seoFilename}`);

  // 2. The row.
  const row = {
    barber_id: barber.id,
    cut_pillar: pillar,
    tags,
    alt_text: processed.altText,
    seo_filename: processed.seoFilename,
    caption: caption || null,
    width: processed.width,
    height: processed.height,
    ghl_file_id: processed.ghlFileId,
    url: processed.url,
  };
  if (sortOrder !== null) row.sort_order = sortOrder;

  const { data: inserted, error: insertErr } = await gallery
    .from("gallery_photos")
    .insert(row)
    .select()
    .single();

  if (insertErr || !inserted) {
    // Orphaned bytes — clean up rather than leave a file nothing references.
    await fetch(`${BACKEND}/api/barber-gallery/file/${processed.ghlFileId}`, {
      method: "DELETE",
      headers: { "x-internal-key": KEY },
    }).catch(() => {});
    throw new Error(`row insert failed (GHL file cleaned up): ${insertErr?.message}`);
  }

  console.log(`  posted : ${inserted.id}`);
  console.log(`  url    : ${inserted.url}`);
})().catch((e) => {
  console.error(`\n  FAILED: ${e.message}`);
  process.exit(1);
});
