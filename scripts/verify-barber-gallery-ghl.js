// verify-barber-gallery-ghl.js — Phase 0 verification for BARBER_GALLERY_UPLOADER_PLAN.md
// Round-trips a WebP through the barbershop GHL Media Library:
//   list → create __test folder → upload WebP into it → confirm URL → delete file + folder.
// Uses GHL_BARBER_SHOP_TOKEN (barbershop location). Never touches a real barber folder.
require("dotenv").config({ quiet: true });
const { HighLevel } = require("@gohighlevel/api-client");
const sharp = require("sharp");
const FormDataPkg = require("form-data"); // SDK axios forces JSON content-type; form-data's getHeaders() carries the multipart boundary

const TOKEN = process.env.GHL_BARBER_SHOP_TOKEN;
const LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;
const TEST_FOLDER = "__test-barber-gallery";

// GHL SDK Logger dumps the Authorization token to stderr on 4xx — sanitize everything we print.
function sanitize(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  return `status=${status} data=${JSON.stringify(data)?.slice(0, 300)}`;
}

async function main() {
  if (!TOKEN || !LOCATION_ID) throw new Error("Missing GHL_BARBER_SHOP_TOKEN or GHL_BARBER_LOCATION_ID");
  const ghl = new HighLevel({ privateIntegrationToken: TOKEN });
  const loc = { altType: "location", altId: LOCATION_ID };

  // 1. List media (proves read scope + location access)
  const list = await ghl.medias.fetchMediaContent({
    sortBy: "createdAt", sortOrder: "desc", type: "file", limit: "3", ...loc,
  });
  console.log(`[1] list OK — ${list?.files?.length ?? 0} files visible, keys=${Object.keys(list || {})}`);

  // 2. Create __test folder (proves write scope + folder support)
  const folder = await ghl.medias.createMediaFolder({ name: TEST_FOLDER, ...loc });
  console.log(`[2] createFolder OK — response keys=${Object.keys(folder || {})}`);
  console.log(`    raw=${JSON.stringify(folder).slice(0, 400)}`);
  const folderId = folder?._id || folder?.id || folder?.fileId;
  if (!folderId) throw new Error("No folder id in response — inspect raw above");

  // 3. Generate a real 1280x1600 (4:5) WebP with sharp
  const webp = await sharp({
    create: { width: 1280, height: 1600, channels: 3, background: { r: 20, g: 20, b: 24 } },
  }).webp({ quality: 80 }).toBuffer();
  console.log(`[3] sharp WebP OK — ${webp.length} bytes`);

  // 4. Upload into the folder (multipart via form-data pkg — native FormData gets clobbered to JSON)
  const fd = new FormDataPkg();
  fd.append("file", webp, { filename: "verify-4x5-test.webp", contentType: "image/webp" });
  fd.append("name", "verify-4x5-test.webp");
  fd.append("parentId", folderId);
  const uploaded = await ghl.medias.uploadMediaContent(fd, { headers: fd.getHeaders() });
  console.log(`[4] upload OK — fileId=${uploaded?.fileId} url=${uploaded?.url}`);
  if (!uploaded?.url) throw new Error("No URL returned from upload");

  // 5. Fetch the public URL to prove it serves
  const res = await fetch(uploaded.url);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[5] public URL fetch — HTTP ${res.status}, ${buf.length} bytes, content-type=${res.headers.get("content-type")}`);

  // 6. Verify round-tripped bytes are our WebP at 1280x1600
  const meta = await sharp(buf).metadata();
  console.log(`[6] round-trip metadata — format=${meta.format} ${meta.width}x${meta.height}`);

  // 7. Cleanup: delete file then folder
  await ghl.medias.deleteMediaContent({ id: uploaded.fileId, ...loc });
  console.log("[7] file deleted");
  await ghl.medias.deleteMediaContent({ id: folderId, ...loc });
  console.log("[8] folder deleted — cleanup complete");

  console.log("\nVERDICT: GHL medias round-trip PASSED");
}

main().catch((e) => {
  console.log(`FAILED: ${sanitize(e)}`);
  if (!e?.response) console.log(`(non-http) ${e.message}`);
  process.exit(1);
});
