// clean-letterbox.js — strip flat black letterbox bands from already-published
// gallery photos (screenshots / reel stills uploaded before the cropper learned
// to auto-trim). Re-crops to a clean 4:5, re-uploads, repoints the row, and
// removes the old GHL file.
//
//   node scripts/clean-letterbox.js --barber=drew            # dry run -> /tmp/letterbox
//   node scripts/clean-letterbox.js --barber=drew --apply    # actually replace
//
// Detection mirrors the client's detectContent(): a band must be DARK and FLAT.
// Real photo content (even a dim background) carries noise, so flatness is what
// keeps this from eating a legitimately dark edge.

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sharp = require("sharp");
const FormData = require("form-data");
const { ghlBarber } = require("../src/clients/ghlMultiLocationSdk");

const PROJECT_REF = "bzojzrgoeknvijrmtdpe";
const OUT_W = 1280, OUT_H = 1600;
// Tight on purpose: true letterbox measures ~0 luminance and perfectly flat,
// while a genuinely dark photo edge sits far higher. A missed bar is harmless;
// a false positive would eat real content.
const DARK = 4, SPREAD = 6, MIN_BAND = 6;
const OUT_DIR = "/tmp/letterbox";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const barberArg = (args.find((a) => a.startsWith("--barber=")) || "").split("=")[1];

function mgmtToken() {
  const raw = execSync(`security find-generic-password -s "Supabase CLI" -w`).toString().trim();
  return Buffer.from(raw.replace("go-keyring-base64:", ""), "base64").toString();
}
async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${mgmtToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** Flat-dark band widths on each edge, in pixels of the given image. */
async function detectBands(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const lum = (x, y) => {
    const i = (y * w + x) * 3;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const flat = (get, n) => {
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (let i = 0; i < n; i++) {
      const v = get(i);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
    }
    return sum / n < DARK && mx - mn < SPREAD;
  };
  let top = 0, bottom = 0, left = 0, right = 0;
  while (top < h - 2 && flat((x) => lum(x, top), w)) top++;
  while (bottom < h - 2 - top && flat((x) => lum(x, h - 1 - bottom), w)) bottom++;
  while (left < w - 2 && flat((y) => lum(left, y), h)) left++;
  while (right < w - 2 - left && flat((y) => lum(w - 1 - right, y), h)) right++;
  const cap = (v, extent) => (v < MIN_BAND ? 0 : Math.min(v, Math.floor(extent * 0.45)));
  return { w, h, top: cap(top, h), bottom: cap(bottom, h), left: cap(left, w), right: cap(right, w) };
}

async function main() {
  if (!barberArg) throw new Error("pass --barber=<slug>");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rows = await sql(`select p.id, p.seo_filename, p.url, p.ghl_file_id, b.slug, b.ghl_media_folder_id
    from gallery_photos p join barbers b on b.id = p.barber_id
    where b.slug = '${barberArg}' order by p.created_at`);
  console.log(`${rows.length} photo(s) for ${barberArg}${APPLY ? "" : "   [DRY RUN]"}\n`);

  let cleaned = 0, skipped = 0;
  for (const r of rows) {
    const buf = Buffer.from(await (await fetch(r.url)).arrayBuffer());
    const b = await detectBands(buf);
    const total = b.top + b.bottom + b.left + b.right;
    if (!total) { skipped++; console.log(`  skip  ${r.seo_filename}`); continue; }

    const region = {
      left: b.left, top: b.top,
      width: b.w - b.left - b.right,
      height: b.h - b.top - b.bottom,
    };
    const out = await sharp(buf)
      .extract(region)
      .resize(OUT_W, OUT_H, { fit: "cover", position: "attention" })
      .webp({ quality: 80 })
      .toBuffer();

    const verify = await detectBands(out);
    const residual = verify.top + verify.bottom + verify.left + verify.right;
    console.log(
      `  clean ${r.seo_filename}\n` +
      `        bands t=${b.top} b=${b.bottom} l=${b.left} r=${b.right} -> ${region.width}x${region.height}` +
      ` -> ${OUT_W}x${OUT_H}  residual=${residual}  ${(out.length / 1024).toFixed(0)}KB`
    );
    fs.writeFileSync(path.join(OUT_DIR, r.seo_filename.replace(/\.webp$/, "") + ".webp"), out);

    if (APPLY) {
      const fd = new FormData();
      fd.append("file", out, { filename: r.seo_filename, contentType: "image/webp" });
      fd.append("name", r.seo_filename);
      fd.append("parentId", r.ghl_media_folder_id);
      const up = await ghlBarber.medias.uploadMediaContent(fd, { headers: fd.getHeaders() });
      if (!up?.url || !up?.fileId) throw new Error("GHL upload returned no url/fileId");
      await sql(`update gallery_photos set url='${up.url}', ghl_file_id='${up.fileId}',
        width=${OUT_W}, height=${OUT_H}, updated_at=now() where id='${r.id}'`);
      // only drop the original once the row points at the replacement
      await ghlBarber.medias.deleteMediaContent({
        id: r.ghl_file_id, altType: "location", altId: process.env.GHL_BARBER_LOCATION_ID,
      });
      console.log(`        applied -> ${up.fileId}`);
    }
    cleaned++;
  }
  console.log(`\n${cleaned} cleaned, ${skipped} already clean. Output: ${OUT_DIR}`);
  if (!APPLY) console.log("Dry run — inspect the files, then re-run with --apply.");
}

main().catch((e) => { console.log("FAILED:", e.message); process.exit(1); });
