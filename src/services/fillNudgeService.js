// fillNudgeService.js
// 24h nudge SMS for non-engaging fill-flow leads. See FILL_FLOW_PLAN.md Phase 4.
//
// Cadence: this runs hourly via Render cron hitting POST /api/tattoo/fill/nudge-sweep.
// Each invocation:
//   1. Pulls all fill_tokens older than 24h that haven't been submitted and
//      haven't been nudged yet.
//   2. Skips rows where the lead has already engaged (last_seen_at > created_at).
//   3. Skips rows where the assigned artist has already sent a personal SMS reply
//      since the inquiry (avoids stepping on an active conversation).
//   4. Defers send when "now" is outside the 9am–8pm America/Chicago window.
//   5. Sends one nudge SMS per eligible row in EN or ES (per stored language).
//
// Idempotency: every "this row is resolved" path stamps `nudge_sent_at` so the
// query never returns it again. The only path that does NOT stamp is the
// outside-send-window deferral — those rows roll over to the next hourly sweep.
//
// Kill switch: LANDING_PAGE_FILL_NUDGE_ENABLED=false short-circuits the sweep.

const { supabase } = require("../clients/supabaseClient");
const { ghl: ghlSdk } = require("../clients/ghlSdk");
const { getContact, getConversationHistory } = require("../clients/ghlClient");
const { ARTIST_USER_IDS } = require("./tattooInquiryService");

// Mirrors the lookup used in tattooInquiryService — keep these in sync.
const ARTIST_FIRST_NAMES = {
  joan: "Joan",
  andrew: "Andrew",
};

// Send window in America/Chicago. 9am inclusive, 8pm exclusive (i.e. 9 ≤ hour < 20).
const SEND_WINDOW_TZ = "America/Chicago";
const SEND_WINDOW_START_HOUR = 9;
const SEND_WINDOW_END_HOUR = 20;

// Cap how many rows we process per invocation. With hourly cadence this leaves
// plenty of headroom for normal volume but bounds the worst-case fan-out
// (each row makes ~2 GHL calls — getContact + getConversationHistory + send).
const MAX_ROWS_PER_SWEEP = 100;

function nudgeEnabled() {
  const v = process.env.LANDING_PAGE_FILL_NUDGE_ENABLED;
  // Default ON. Only "false" (case-insensitive) flips it off.
  return !(typeof v === "string" && v.toLowerCase() === "false");
}

/**
 * Whether *now* is inside the send window in America/Chicago.
 * Uses Intl.DateTimeFormat so we don't have to ship a timezone DB.
 */
function isInsideSendWindow(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: SEND_WINDOW_TZ,
    hour: "numeric",
    hour12: false,
  });
  const hourStr = fmt.format(now);
  const hour = parseInt(hourStr, 10);
  if (!Number.isFinite(hour)) {
    // If parsing ever blows up, lean conservative — defer.
    return false;
  }
  return hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR;
}

function buildNudgeBody({ artistFirstName, shortUrl, language }) {
  const isEs = language === "es" || language === "spanish";
  if (isEs) {
    return `Parece que ${artistFirstName} aún está respondiendo a otros mensajes. Llena unos detalles rápidos para agilizar: ${shortUrl}`;
  }
  return `Looks like ${artistFirstName} is still working through other inquiries. Filling in a few details speeds things up: ${shortUrl}`;
}

const FILL_BASE_URL =
  process.env.FILL_BASE_URL || "https://fill.studioaztattoo.com";

function buildShortUrl(token) {
  return `${FILL_BASE_URL}/${token}`;
}

/**
 * Conditional stamp: only set nudge_sent_at if it's still NULL. Returns true
 * when we won the race, false when another sweep beat us to it. Either outcome
 * is fine — the SMS doesn't fire twice because we stamp BEFORE sending and
 * bail on lost-race.
 */
async function claimRow(token) {
  const { data, error } = await supabase
    .from("fill_tokens")
    .update({ nudge_sent_at: new Date().toISOString() })
    .eq("token", token)
    .is("nudge_sent_at", null)
    .select("token")
    .maybeSingle();

  if (error) {
    console.error(`[fillNudge] claimRow update failed for ${token}:`, error.message);
    return false;
  }
  return !!data;
}

/**
 * Did the assigned artist send any *personal* outbound message in this contact's
 * conversation since the inquiry? "Personal" excludes the auto-confirmation SMS
 * (which is sent on behalf of the artist's userId at inquiry time).
 *
 * We treat any outbound from `artistUserId` more than 60s after `inquiryCreatedAt`
 * as a personal reply. The auto-SMS is sent within the same request as the
 * inquiry so it always lands inside that 60s grace window. This mirrors the
 * fallback boundary used in src/analytics/leadFunnelAnalytics.js.
 */
async function artistRepliedSinceInquiry({ contactId, artistUserId, inquiryCreatedAt }) {
  let messages = [];
  try {
    messages = await getConversationHistory(contactId, {
      limit: 100,
      sortOrder: "asc",
    });
  } catch (err) {
    // If we can't read conversation history we can't safely judge — re-throw so
    // the caller can decide (we don't want to nudge a lead who's already mid-
    // conversation with the artist).
    throw new Error(`getConversationHistory(${contactId}) failed: ${err.message}`);
  }

  const inquiryEpoch = new Date(inquiryCreatedAt).getTime();
  if (!Number.isFinite(inquiryEpoch)) return false;
  const personalBoundary = inquiryEpoch + 60 * 1000;

  for (const m of messages) {
    if (m?.direction !== "outbound") continue;
    if (m?.userId !== artistUserId) continue;
    const ts = m?.dateAdded || m?.createdAt;
    if (!ts) continue;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (t > personalBoundary) {
      return true;
    }
  }
  return false;
}

/**
 * Process a single eligible token row. Returns one of:
 *   - { status: "sent" }              — nudge SMS dispatched
 *   - { status: "skipped_engaged" }   — lead already clicked the link
 *   - { status: "skipped_replied" }   — artist already replied personally
 *   - { status: "skipped_contact" }   — contact gone in GHL
 *   - { status: "skipped_unknown_artist" }  — artist slug not mapped
 *   - { status: "deferred_window" }   — outside send window (NOT stamped)
 *   - { status: "lost_race" }         — concurrent sweep beat us
 *   - { status: "error", error }      — fatal error for this row (NOT stamped)
 */
async function processTokenRow(row, now = new Date()) {
  // Skip if lead has clicked the link (either before or after the 24h mark
  // doesn't matter — they're aware of the form).
  if (row.last_seen_at && new Date(row.last_seen_at) > new Date(row.created_at)) {
    if (await claimRow(row.token)) {
      return { status: "skipped_engaged" };
    }
    return { status: "lost_race" };
  }

  // Map artist slug → GHL user ID. ARTIST_USER_IDS is the source of truth.
  const artistUserId = ARTIST_USER_IDS[row.artist_slug];
  if (!artistUserId) {
    console.warn(`[fillNudge] Unknown artist slug ${row.artist_slug} on token ${row.token}`);
    if (await claimRow(row.token)) {
      return { status: "skipped_unknown_artist" };
    }
    return { status: "lost_race" };
  }

  // Make sure the contact still exists. Merged/deleted contacts can't be SMS'd
  // and shouldn't sit in the queue forever.
  let contact = null;
  try {
    contact = await getContact(row.contact_id);
  } catch (err) {
    return { status: "error", error: `getContact failed: ${err.message}` };
  }
  if (!contact) {
    if (await claimRow(row.token)) {
      return { status: "skipped_contact" };
    }
    return { status: "lost_race" };
  }

  // Has the artist already personally replied? If yes, the conversation is
  // already moving — a nudge would feel like spam.
  let alreadyReplied = false;
  try {
    alreadyReplied = await artistRepliedSinceInquiry({
      contactId: row.contact_id,
      artistUserId,
      inquiryCreatedAt: row.created_at,
    });
  } catch (err) {
    // Be cautious: if we can't tell, don't nudge this round. Don't stamp
    // either — rolls over to the next hourly sweep so a transient GHL hiccup
    // doesn't lose the lead.
    return { status: "error", error: err.message };
  }
  if (alreadyReplied) {
    if (await claimRow(row.token)) {
      return { status: "skipped_replied" };
    }
    return { status: "lost_race" };
  }

  // Outside the 9am–8pm Central send window? Defer without stamping.
  if (!isInsideSendWindow(now)) {
    return { status: "deferred_window" };
  }

  // Stamp first, then send. If the SMS send fails after stamping we'll log it
  // but won't retry — same trade-off the auto-SMS makes (errs on the side of
  // not double-texting).
  if (!(await claimRow(row.token))) {
    return { status: "lost_race" };
  }

  const artistFirstName =
    ARTIST_FIRST_NAMES[row.artist_slug] ||
    row.artist_slug.charAt(0).toUpperCase() + row.artist_slug.slice(1);

  const body = buildNudgeBody({
    artistFirstName,
    shortUrl: buildShortUrl(row.token),
    language: row.language || "en",
  });

  try {
    await ghlSdk.conversations.sendANewMessage({
      type: "SMS",
      contactId: row.contact_id,
      message: body,
    });
    console.log(
      `📱 [FILL-NUDGE] Sent to contact ${row.contact_id} (token ${row.token}, artist ${row.artist_slug}, lang ${row.language || "en"})`
    );
    return { status: "sent" };
  } catch (err) {
    console.error(
      `❌ [FILL-NUDGE] SMS send failed for token ${row.token}:`,
      err.response?.data || err.message
    );
    return { status: "error", error: err.message || "SMS send failed" };
  }
}

/**
 * Main entry point. Pulls eligible rows and processes each one.
 * Always returns a tally; never throws (except misconfiguration).
 */
async function runNudgeSweep() {
  if (!supabase) {
    throw new Error("Supabase client not configured");
  }

  if (!nudgeEnabled()) {
    return { ok: true, disabled: true, processed: 0 };
  }

  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from("fill_tokens")
    .select("token, contact_id, artist_slug, language, created_at, last_seen_at")
    .lt("created_at", cutoffIso)
    .is("submitted_at", null)
    .is("nudge_sent_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS_PER_SWEEP);

  if (error) {
    throw new Error(`fill_tokens nudge query failed: ${error.message}`);
  }

  const tally = {
    ok: true,
    candidates: rows?.length || 0,
    sent: 0,
    skipped_engaged: 0,
    skipped_replied: 0,
    skipped_contact: 0,
    skipped_unknown_artist: 0,
    deferred_window: 0,
    lost_race: 0,
    errors: 0,
  };

  if (!rows || rows.length === 0) {
    return tally;
  }

  const now = new Date();

  // Process serially. Concurrency would shave wall-clock time but our hourly
  // cadence + low volume means this is a non-issue, and serial keeps GHL
  // rate-limit pressure predictable.
  for (const row of rows) {
    let result;
    try {
      result = await processTokenRow(row, now);
    } catch (err) {
      console.error(`[fillNudge] processTokenRow threw for ${row.token}:`, err);
      tally.errors += 1;
      continue;
    }

    switch (result.status) {
      case "sent":
        tally.sent += 1;
        break;
      case "skipped_engaged":
        tally.skipped_engaged += 1;
        break;
      case "skipped_replied":
        tally.skipped_replied += 1;
        break;
      case "skipped_contact":
        tally.skipped_contact += 1;
        break;
      case "skipped_unknown_artist":
        tally.skipped_unknown_artist += 1;
        break;
      case "deferred_window":
        tally.deferred_window += 1;
        break;
      case "lost_race":
        tally.lost_race += 1;
        break;
      case "error":
        tally.errors += 1;
        break;
      default:
        tally.errors += 1;
    }
  }

  return tally;
}

module.exports = {
  runNudgeSweep,
  // Exported for tests / direct invocation
  isInsideSendWindow,
  buildNudgeBody,
  processTokenRow,
};
