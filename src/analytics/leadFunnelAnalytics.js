// leadFunnelAnalytics.js
// Phase 4.5 of FILL_FLOW_PLAN.md — Tier 1 funnel snapshot.
//
// Two questions this answers:
//   1. Is the fill form working? (counts + rates over fill_tokens)
//   2. Are artists responding fast enough? (per-artist time-to-first-reply, GHL-sourced)
//
// Design notes / foreseen problems:
//   - Cache: 5-min in-memory TTL keyed by windowDays. The endpoint is internal-
//     only and rarely accessed; per-request GHL fetches would be too slow with
//     ~hundreds of contacts.
//   - GHL fan-out: per-contact getConversationHistory is the bottleneck.
//     Concurrency-cap at 5 to be polite to GHL's rate limiter.
//   - Auto-SMS exclusion: prefer the contact's last_auto_sms_at custom field
//     (set in tattooInquiryService when the auto-SMS sends). Fallback for
//     contacts that predate the field: skip outbound messages whose timestamp
//     is within 60s of the inquiry token created_at — by far the most likely
//     window for the auto-SMS round-trip.
//   - Zero-guard: every divisor is wrapped in safeRate to return 0 instead of
//     NaN/Infinity when the cohort is empty.
//   - Partial GHL failures: if a single contact's history fetch fails, that
//     contact is dropped from timing calculations and counted in
//     `timing._dropped`. Funnel counts are unaffected (Supabase-only).

const { supabase } = require("../clients/supabaseClient");
const { getConversationHistory, getContact } = require("../clients/ghlClient");
const { ARTIST_USER_IDS } = require("../services/tattooInquiryService");

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key: `days:${n}` -> { value, expiresAt }

const GHL_CONCURRENCY = 5;
const AUTO_SMS_FALLBACK_WINDOW_MS = 60 * 1000;
const LAST_AUTO_SMS_AT_FIELD_ID = "EjpTbHO59al8yiS2QP7E";
const LAST_AUTO_SMS_AT_FIELD_KEY = "last_auto_sms_at";

const ARTIST_SLUG_BY_USER_ID = Object.fromEntries(
  Object.entries(ARTIST_USER_IDS).map(([slug, id]) => [id, slug])
);

function safeRate(numer, denom) {
  if (!denom || denom <= 0) return 0;
  const r = numer / denom;
  return Number.isFinite(r) ? Math.round(r * 1000) / 1000 : 0;
}

/**
 * Median (linear-interpolated) and 90th-percentile of an array of numbers.
 * Returns nulls when the array is empty so callers can render "—" cleanly
 * instead of pretending zero is a valid measurement.
 */
function summarize(values) {
  if (!values || values.length === 0) return { median: null, p90: null, n: 0 };
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { median: null, p90: null, n: 0 };

  const pick = (p) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const frac = idx - lo;
    return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
  };

  return {
    median: Math.round(pick(0.5) * 10) / 10,
    p90: Math.round(pick(0.9) * 10) / 10,
    n: sorted.length,
  };
}

/**
 * Run an async mapper over `items` with at most `concurrency` in flight.
 * Errors per item are captured and returned alongside successes so the caller
 * can decide how to handle partial failures.
 */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(worker);
  await Promise.all(workers);
  return results;
}

/**
 * Read `last_auto_sms_at` from a contact record. Returns Date or null.
 * The contact object can carry the field as either an object map (customField)
 * or an array (customFields). getContact() normalizes to both — be defensive.
 */
function extractLastAutoSmsAt(contact) {
  if (!contact) return null;

  // Object form: customField[fieldId] = value
  const fromObj = contact.customField?.[LAST_AUTO_SMS_AT_FIELD_ID];
  if (fromObj) {
    const d = new Date(fromObj);
    if (!isNaN(d.getTime())) return d;
  }

  // Array form: customFields = [{ id, value | field_value }]
  if (Array.isArray(contact.customFields)) {
    const match = contact.customFields.find(
      (f) => f.id === LAST_AUTO_SMS_AT_FIELD_ID || f.fieldKey === `contact.${LAST_AUTO_SMS_AT_FIELD_KEY}`
    );
    const v = match?.value ?? match?.field_value;
    if (v) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d;
    }
  }

  return null;
}

/**
 * For one contact: find the artist's first *real* outbound reply.
 * Returns { firstReplyAt: Date|null, autoSmsAt: Date|null }.
 *
 * "Real" means:
 *   - direction === "outbound"
 *   - userId === the artist's GHL user ID (so we ignore other staff)
 *   - timestamp > last_auto_sms_at (or > created_at + 60s if the field is unset)
 *
 * If the artist has multiple inquiries with this contact, we take the earliest
 * reply after the inquiry created_at — same conversation, multiple cohorts is
 * fine because each cohort row gets its own delta.
 */
async function findArtistFirstReply({ contactId, artistUserId, inquiryCreatedAt }) {
  let contact = null;
  try {
    contact = await getContact(contactId);
  } catch (err) {
    // Don't fail the whole snapshot — just skip this contact.
    throw new Error(`getContact(${contactId}) failed: ${err.message}`);
  }
  if (!contact) {
    throw new Error(`contact ${contactId} not found`);
  }

  const lastAutoSmsAt = extractLastAutoSmsAt(contact);
  // Boundary used to exclude the auto-SMS. Defaults to created_at + 60s when
  // the field is unset (legacy contacts predate the field).
  const fallbackBoundary = new Date(
    new Date(inquiryCreatedAt).getTime() + AUTO_SMS_FALLBACK_WINDOW_MS
  );
  const skipBefore = lastAutoSmsAt
    ? new Date(lastAutoSmsAt.getTime() + 1000) // +1s slack so we don't catch the stamp itself
    : fallbackBoundary;

  let messages = [];
  try {
    messages = await getConversationHistory(contactId, {
      limit: 200,
      sortOrder: "asc", // earliest first; we want the first reply
    });
  } catch (err) {
    throw new Error(`getConversationHistory(${contactId}) failed: ${err.message}`);
  }

  // First outbound message from this artist that is NOT the auto-SMS.
  for (const m of messages) {
    if (m?.direction !== "outbound") continue;
    if (m?.userId !== artistUserId) continue;
    const ts = m?.dateAdded || m?.createdAt;
    if (!ts) continue;
    const t = new Date(ts);
    if (isNaN(t.getTime())) continue;
    if (t < new Date(inquiryCreatedAt)) continue; // pre-inquiry msg, ignore
    if (t < skipBefore) continue;                  // the auto-SMS or earlier
    return { firstReplyAt: t, autoSmsAt: lastAutoSmsAt };
  }

  return { firstReplyAt: null, autoSmsAt: lastAutoSmsAt };
}

/**
 * Funnel-counts SQL using percentile_cont for medians done in-DB. We use the
 * supabase-js client which doesn't expose raw SQL, so we fetch the rows and
 * compute medians in JS. For the volume in question (low hundreds per month
 * at most), this is fine.
 */
async function fetchFillTokenRows(windowDays) {
  if (!supabase) {
    throw new Error("Supabase client not configured");
  }
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // No `.range()` — caps at 1000 rows by default, plenty for v1; if we ever
  // exceed that, switch to fetchAllRows().
  const { data, error } = await supabase
    .from("fill_tokens")
    .select("token, contact_id, artist_slug, created_at, last_seen_at, first_step_completed_at, last_step_completed_at, submitted_at, nudge_sent_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    throw new Error(`fill_tokens query failed: ${error.message}`);
  }
  return data || [];
}

/**
 * Produce a funnel snapshot for the last `windowDays` days. Cached for
 * CACHE_TTL_MS in-process. Pass `force = true` to bypass the cache (useful
 * after a known data-changing event).
 */
async function getFunnelSnapshot(windowDays = 30, { force = false } = {}) {
  const days = Math.max(1, Math.min(Number(windowDays) || 30, 365));
  const cacheKey = `days:${days}`;
  const now = Date.now();

  if (!force) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { ...cached.value, _cache: { hit: true, ageMs: now - cached.computedAt } };
    }
  }

  const rows = await fetchFillTokenRows(days);
  const fromIso = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const toIso = new Date(now).toISOString();

  // Funnel counts — straight pass over rows.
  const totals = {
    inquiries: rows.length,
    fill_tokens_created: rows.length,
    fill_links_clicked: rows.filter((r) => r.last_seen_at).length,
    fill_started: rows.filter((r) => r.first_step_completed_at).length,
    fill_completed: rows.filter((r) => r.submitted_at).length,
    nudges_sent: rows.filter((r) => r.nudge_sent_at).length,
  };

  const completedAfterNudge = rows.filter(
    (r) => r.nudge_sent_at && r.submitted_at && new Date(r.submitted_at) > new Date(r.nudge_sent_at)
  ).length;

  const rates = {
    click_through: safeRate(totals.fill_links_clicked, totals.fill_tokens_created),
    engagement: safeRate(totals.fill_started, totals.fill_tokens_created),
    completion: safeRate(totals.fill_completed, totals.fill_tokens_created),
    click_to_complete: safeRate(totals.fill_completed, totals.fill_links_clicked),
    nudge_recovery: safeRate(completedAfterNudge, totals.nudges_sent),
  };

  // Page-side timing (Supabase only — no GHL needed).
  const minutes = (a, b) => (new Date(b) - new Date(a)) / 60000;
  const inquiryToClickMins = rows
    .filter((r) => r.last_seen_at)
    .map((r) => minutes(r.created_at, r.last_seen_at));
  const clickToSubmitMins = rows
    .filter((r) => r.last_seen_at && r.submitted_at)
    .map((r) => minutes(r.last_seen_at, r.submitted_at));

  // Artist-reply timing — fan out to GHL with concurrency cap.
  const ghlInputs = rows
    .filter((r) => ARTIST_USER_IDS[r.artist_slug])
    .map((r) => ({
      token: r.token,
      contactId: r.contact_id,
      artistSlug: r.artist_slug,
      artistUserId: ARTIST_USER_IDS[r.artist_slug],
      inquiryCreatedAt: r.created_at,
      submittedAt: r.submitted_at,
    }));

  const ghlResults = await mapWithConcurrency(ghlInputs, GHL_CONCURRENCY, async (input) => {
    const { firstReplyAt, autoSmsAt } = await findArtistFirstReply({
      contactId: input.contactId,
      artistUserId: input.artistUserId,
      inquiryCreatedAt: input.inquiryCreatedAt,
    });
    return { ...input, firstReplyAt, autoSmsAt };
  });

  // Aggregate — overall + per artist.
  const overallReplyHours = [];
  const perArtist = new Map();
  let dropped = 0;

  for (let i = 0; i < ghlResults.length; i++) {
    const meta = ghlInputs[i];
    const r = ghlResults[i];
    const slug = meta.artistSlug;
    if (!perArtist.has(slug)) {
      perArtist.set(slug, {
        slug,
        inquiries: 0,
        fill_completed: 0,
        replyHours: [],
        repliedWithin24h: 0,
        repliedTotal: 0,
      });
    }
    const bucket = perArtist.get(slug);
    bucket.inquiries += 1;
    if (meta.submittedAt) bucket.fill_completed += 1;

    if (!r.ok) {
      dropped += 1;
      continue;
    }
    const reply = r.value.firstReplyAt;
    if (reply) {
      const hours = (reply - new Date(meta.inquiryCreatedAt)) / 3600000;
      overallReplyHours.push(hours);
      bucket.replyHours.push(hours);
      bucket.repliedTotal += 1;
      if (hours <= 24) bucket.repliedWithin24h += 1;
    }
  }

  const overallStats = summarize(overallReplyHours);
  const inquiryToClickStats = summarize(inquiryToClickMins);
  const clickToSubmitStats = summarize(clickToSubmitMins);

  const byArtist = Array.from(perArtist.values())
    .map((b) => {
      const stats = summarize(b.replyHours);
      return {
        slug: b.slug,
        inquiries: b.inquiries,
        fill_completed: b.fill_completed,
        completion_rate: safeRate(b.fill_completed, b.inquiries),
        median_hours_to_first_reply: stats.median,
        p90_hours_to_first_reply: stats.p90,
        replied_within_24h_rate: safeRate(b.repliedWithin24h, b.repliedTotal),
        replies_observed: b.repliedTotal,
      };
    })
    .sort((a, b) => b.inquiries - a.inquiries);

  const value = {
    window: { days, from: fromIso, to: toIso },
    totals,
    rates,
    timing: {
      median_minutes_inquiry_to_click: inquiryToClickStats.median,
      median_minutes_click_to_submit: clickToSubmitStats.median,
      median_hours_inquiry_to_artist_first_reply_overall: overallStats.median,
      p90_hours_inquiry_to_artist_first_reply_overall: overallStats.p90,
      _replies_observed: overallStats.n,
      _dropped: dropped,
    },
    by_artist: byArtist,
  };

  cache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS, computedAt: now });
  return { ...value, _cache: { hit: false, ageMs: 0 } };
}

function clearFunnelCache() {
  cache.clear();
}

module.exports = {
  getFunnelSnapshot,
  clearFunnelCache,
  // Exported for testing
  _summarize: summarize,
  _safeRate: safeRate,
  _extractLastAutoSmsAt: extractLastAutoSmsAt,
};
