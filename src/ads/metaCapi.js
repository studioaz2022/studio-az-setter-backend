// ─── Meta Conversions API — server-side Purchase events ─────────────
//
// Design locked in ~/Documents/Ads/02-campaigns/gilberto-pilot/
// capi-and-ltv-design.md (2026-07-17, with Lionel):
//   • Hook point: the barber payment-confirm choke points (Square
//     bulk-confirm + Venmo confirm). A confirmed, appointment-matched
//     transaction IS the purchase.
//   • value = service + TIP (booth-rent economics: client worth is
//     service+tip; great tippers are better clients — signal, not noise).
//   • event_id = Square payment id (Venmo: the Venmo transaction id) —
//     idempotent; Meta dedups replays of the same confirm.
//   • user_data = SHA-256 email + phone from the GHL contact, plus the
//     _fbp/_fbc click ids captured at booking (booking_attribution).
//   • action_source = physical_store — the money changes hands in the
//     chair; Meta matches back to the ad click via fbp/fbc/em/ph.
//   • Meta accepts events ~7 days back. Older confirms are skipped here
//     (they still count in OUR ROAS ledger forever) — which is why
//     Gilberto is coached to confirm same/next day.
//
// Failure posture: fire-and-forget. A CAPI hiccup must never fail or slow
// a barber's confirm flow — callers invoke sendPurchasesForConfirmed()
// without awaiting and every error lands in the log, not the response.

const axios = require("axios");
const crypto = require("crypto");

// The barbershop pixel/dataset. Tattoo gets its own sender when its ads
// go live — do not reuse this id there.
const BARBER_PIXEL_ID = "729831282095610";
const GRAPH = "https://graph.facebook.com/v21.0";

// Meta rejects events older than this; skip rather than error.
const MAX_EVENT_AGE_DAYS = 7;

// When set (e.g. on a staging deploy), every event routes to the pixel's
// Test Events tab instead of production data.
const TEST_EVENT_CODE = process.env.META_CAPI_TEST_EVENT_CODE || null;

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

/** Meta's normalization rules: email lowercase/trimmed; phone digits with
 *  country code (US 10-digit gets a leading 1). */
function hashEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e.includes("@") ? sha256(e) : null;
}
function hashPhone(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10) d = `1${d}`;
  return d.length >= 11 ? sha256(d) : null;
}

/** Pseudo contact ids the confirm flows use for unattributable payments. */
const PSEUDO_CONTACTS = new Set(["walk_in", "venmo_unmatched", "unmatched"]);

async function fetchContact(contactId) {
  const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
  const resp = await ghlBarber.contacts.getContact({ contactId });
  return resp?.contact || resp || null;
}

/** Latest click ids captured for this contact at booking (30-day lookback —
 *  matches the _fbp cookie's own lifetime). */
async function fetchClickIds(supabase, contactId) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data } = await supabase
    .from("booking_attribution")
    .select("fbp, fbc")
    .eq("contact_id", contactId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

function buildEvent(tx, contact, clickIds) {
  const service = Number(tx.service_price) || 0;
  const tip = Number(tx.tip_amount) || 0;
  const value = service + tip > 0 ? +(service + tip).toFixed(2) : Number(tx.gross_amount) || 0;
  if (!(value > 0)) return { skip: "zero value" };

  const eventId = tx.square_payment_id || tx.venmo_transaction_id || tx.id;
  const when = tx.square_payment_time || tx.session_date || tx.created_at;
  const eventTime = Math.floor(new Date(when).getTime() / 1000);
  if (!Number.isFinite(eventTime)) return { skip: "no event time" };

  const ageDays = (Date.now() / 1000 - eventTime) / 86400;
  if (ageDays > MAX_EVENT_AGE_DAYS) {
    return { skip: `${ageDays.toFixed(1)}d old (window is ${MAX_EVENT_AGE_DAYS}d)` };
  }

  const em = hashEmail(contact?.email);
  const ph = hashPhone(contact?.phone);
  const userData = {
    ...(em ? { em: [em] } : {}),
    ...(ph ? { ph: [ph] } : {}),
    ...(clickIds?.fbp ? { fbp: clickIds.fbp } : {}),
    ...(clickIds?.fbc ? { fbc: clickIds.fbc } : {}),
    external_id: [sha256(String(tx.contact_id))],
  };
  if (!em && !ph && !clickIds?.fbp && !clickIds?.fbc) {
    return { skip: "no matchable user data" };
  }

  return {
    event: {
      event_name: "Purchase",
      event_time: eventTime,
      event_id: String(eventId),
      action_source: "physical_store",
      user_data: userData,
      custom_data: {
        value,
        currency: "USD",
        ...(tx.calendar_id ? { content_name: String(tx.calendar_id) } : {}),
      },
    },
  };
}

async function postEvents(events, { testEventCode } = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error("META_ACCESS_TOKEN not set");
  const body = {
    data: events,
    ...(testEventCode || TEST_EVENT_CODE
      ? { test_event_code: testEventCode || TEST_EVENT_CODE }
      : {}),
  };
  const { data } = await axios.post(
    `${GRAPH}/${BARBER_PIXEL_ID}/events`,
    body,
    { params: { access_token: token }, timeout: 15000 }
  );
  return data; // { events_received, fbtrace_id }
}

/**
 * Send CAPI Purchase events for freshly confirmed transactions.
 * Callers pass whichever handles they have — Square payment ids from
 * bulk-confirm, Supabase row ids from Venmo confirm. Rows are re-read
 * from the database AFTER the confirm wrote them, so values reflect any
 * tip/service re-split the confirm applied.
 *
 * Fire-and-forget by contract: call without awaiting, errors are logged.
 */
async function sendPurchasesForConfirmed({
  barberGhlId,
  squarePaymentIds = [],
  supabaseIds = [],
  testEventCode = null,
}) {
  if (!squarePaymentIds.length && !supabaseIds.length) return { sent: 0 };
  const { supabase } = require("../clients/supabaseClient");

  let query = supabase
    .from("transactions")
    .select(
      "id, contact_id, appointment_id, service_price, tip_amount, gross_amount, " +
        "square_payment_id, venmo_transaction_id, square_payment_time, session_date, " +
        "created_at, calendar_id"
    )
    .eq("artist_ghl_id", barberGhlId)
    .is("deleted_at", null)
    .is("superseded_by", null);
  query = squarePaymentIds.length
    ? query.in("square_payment_id", squarePaymentIds)
    : query.in("id", supabaseIds);

  const { data: rows, error } = await query;
  if (error) throw new Error(`transactions read failed: ${error.message}`);

  const events = [];
  const skips = [];
  for (const tx of rows || []) {
    if (!tx.contact_id || PSEUDO_CONTACTS.has(tx.contact_id)) {
      skips.push(`${tx.id}: no real contact`);
      continue;
    }
    let contact = null;
    try {
      contact = await fetchContact(tx.contact_id);
    } catch (err) {
      skips.push(`${tx.id}: contact fetch failed (${err.message})`);
    }
    const clickIds = await fetchClickIds(supabase, tx.contact_id).catch(() => null);
    const built = buildEvent(tx, contact, clickIds);
    if (built.skip) {
      skips.push(`${tx.id}: ${built.skip}`);
      continue;
    }
    events.push(built.event);
  }

  let received = 0;
  if (events.length) {
    const resp = await postEvents(events, { testEventCode });
    received = resp?.events_received ?? events.length;
  }
  console.log(
    `[CAPI] ${barberGhlId}: ${received} Purchase event(s) sent` +
      (skips.length ? `; skipped ${skips.length} — ${skips.join(" | ")}` : "")
  );
  return { sent: received, skipped: skips };
}

module.exports = { sendPurchasesForConfirmed, postEvents, buildEvent, BARBER_PIXEL_ID };
