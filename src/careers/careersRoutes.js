// ─── Careers / barber recruiting routes ───
//
//   POST /api/careers/apply                 public — the careers-page wizard posts here
//   GET  /api/careers/applications          Lionel-only (x-owner-key) — iOS Applicants screen
//   PUT  /api/careers/applications/:id/status  Lionel-only — review status updates
//
// Flow on apply: validate → insert barber_applications (canonical store) →
// upsert GHL contact in the BARBERSHOP location with tag "barber-application"
// → push Lionel. GHL and push failures never fail the application — the
// Supabase row is the source of truth and the iOS screen reads from it.

const express = require("express");
const { supabase } = require("../clients/supabaseClient");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const { sendPushToGhlUser } = require("../services/taskNotifications");

const router = express.Router();
router.use(express.json({ limit: "256kb" }));

const BARBER_LOCATION_ID =
  process.env.GHL_BARBER_LOCATION_ID || "GLRkNAxfPtWTqTiN83xj";
const LIONEL_GHL_USER_ID = "1kFG5FWdUDhXLUX46snG"; // src/config/constants.js GHL_USER_IDS.LIONEL

// ── Lionel-only gate (same secret the iOS Tools refunds card uses) ──
function requireOwnerKey(req, res, next) {
  const expected = process.env.OWNER_SETTLE_KEY;
  if (!expected) {
    res.status(503).json({ error: "owner key not configured" });
    return;
  }
  if (req.get("x-owner-key") !== expected) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

// ── Simple per-IP rate limit for the public endpoint (bookingCreate pattern) ──
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const rateBuckets = new Map(); // ip -> [timestamps]

function clientIp(req) {
  const fwd = req.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : req.ip || "").trim() || "unknown";
}

function rateLimited(ip) {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // crude memory guard
  return false;
}

const FIELDS = [
  "name",
  "phone",
  "email",
  "portfolio",
  "experience",
  "fit",
  "feedback",
];

// ── POST /api/careers/apply ──
router.post("/apply", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ ok: false, error: "storage_unavailable" });
  }
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }

  const body = req.body || {};
  const row = {};
  for (const f of FIELDS) {
    const v = body[f];
    if (typeof v !== "string" || !v.trim()) {
      return res.status(400).json({ ok: false, error: `missing_${f}` });
    }
    if (v.length > 4000) {
      return res.status(400).json({ ok: false, error: `too_long_${f}` });
    }
    row[f] = v.trim();
  }
  row.source =
    typeof body.source === "string" && body.source.trim()
      ? body.source.trim().slice(0, 64)
      : "careers_page";

  // Resubmit within 24h with the same email → idempotent, update the row
  // instead of stacking duplicates.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("barber_applications")
    .select("id")
    .eq("email", row.email)
    .gte("created_at", dayAgo)
    .order("created_at", { ascending: false })
    .limit(1);

  let applicationId;
  if (recent && recent.length > 0) {
    applicationId = recent[0].id;
    const { error } = await supabase
      .from("barber_applications")
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq("id", applicationId);
    if (error) {
      console.error("[careers] resubmit update failed:", error.message);
      return res.status(500).json({ ok: false, error: "storage_failed" });
    }
  } else {
    const { data, error } = await supabase
      .from("barber_applications")
      .insert([row])
      .select("id")
      .single();
    if (error) {
      console.error("[careers] insert failed:", error.message);
      return res.status(500).json({ ok: false, error: "storage_failed" });
    }
    applicationId = data.id;
  }

  // The application is saved — everything past here is best-effort.
  res.json({ ok: true });

  // GHL: upsert the applicant as a barbershop-location contact, tagged.
  try {
    if (ghlBarber) {
      const [firstName, ...rest] = row.name.split(/\s+/);
      const up = await ghlBarber.contacts.upsertContact({
        locationId: BARBER_LOCATION_ID,
        firstName,
        lastName: rest.join(" ") || undefined,
        email: row.email,
        phone: row.phone,
        source: "website:careers-page",
        tags: ["barber-application"],
      });
      const contactId = up?.contact?.id || up?.id || null;
      if (contactId) {
        await supabase
          .from("barber_applications")
          .update({ ghl_contact_id: contactId })
          .eq("id", applicationId);
      }
    }
  } catch (err) {
    console.error("[careers] GHL upsert failed (non-fatal):", err.message);
  }

  // Push Lionel. locationId drives the iOS brand switch on tap.
  try {
    await sendPushToGhlUser(LIONEL_GHL_USER_ID, {
      type: "barber_application",
      title: "New barber application",
      body: `${row.name} applied for a chair — ${row.experience.slice(0, 80)}`,
      locationId: BARBER_LOCATION_ID,
      data: { applicationId },
    });
  } catch (err) {
    console.error("[careers] push failed (non-fatal):", err.message);
  }
});

// ── GET /api/careers/applications ──
// Optional ?status=new,contacted filter. Newest first.
router.get("/applications", requireOwnerKey, async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "storage_unavailable" });
  }
  let query = supabase
    .from("barber_applications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (typeof req.query.status === "string" && req.query.status.trim()) {
    query = query.in(
      "status",
      req.query.status.split(",").map((s) => s.trim())
    );
  }
  const { data, error } = await query;
  if (error) {
    console.error("[careers] list failed:", error.message);
    return res.status(500).json({ error: "storage_failed" });
  }
  res.json({ applications: data });
});

// ── PUT /api/careers/applications/:id/status ──
const STATUSES = [
  "new",
  "contacted",
  "interview",
  "accepted",
  "rejected",
  "archived",
];

router.put("/applications/:id/status", requireOwnerKey, async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "storage_unavailable" });
  }
  const { status, notes } = req.body || {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: "bad_status" });
  }
  const patch = {
    status,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (typeof notes === "string") patch.review_notes = notes.slice(0, 4000);
  const { data, error } = await supabase
    .from("barber_applications")
    .update(patch)
    .eq("id", req.params.id)
    .select("id, status")
    .single();
  if (error) {
    console.error("[careers] status update failed:", error.message);
    return res.status(500).json({ error: "storage_failed" });
  }
  res.json({ ok: true, application: data });
});

module.exports = router;
