#!/usr/bin/env node
// ─── Did the deposit path work for a real client? ─────────────────────
//
// Lionel's calendar is the only one where the website takes a deposit, so
// the card step, the charge-before-book order, and the deposit rows on the
// confirmation ticket can't be exercised on any test calendar. The proof
// has to come from the first real booking. This reads the five signals
// that booking leaves behind and says which ones landed:
//
//   1. audit_events   — the booking row, with "deposit $NN paid=<square id>"
//                       and none of the FAILED markers
//   2. transactions   — the Square ledger row the rent tracker reads
//   3. GHL            — the appointment exists and is confirmed
//   4. GHL SMS        — the confirmation text went out with the trigger link
//   5. GA4            — the client's browser reached /confirmation with
//                       deposit_paid= in the URL (the widget handoff). GA4
//                       lags a day or two; a miss here on day one means
//                       "not processed yet", not "didn't happen".
//
//   node scripts/check-deposit-booking.js            # latest chavez booking
//   node scripts/check-deposit-booking.js <apptId>   # a specific one
require("dotenv").config();
const { runReport } = require("../src/seo/ga4DataClient");

const SB = process.env.SUPABASE_URL;
const SBK = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const GHL = process.env.GHL_BARBER_SHOP_TOKEN;
const sb = (path) =>
  fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SBK, Authorization: `Bearer ${SBK}` } }).then((r) => r.json());
const ghl = (path, v = "2021-04-15") =>
  fetch(`https://services.leadconnectorhq.com${path}`, { headers: { Authorization: `Bearer ${GHL}`, Version: v } }).then((r) => r.json());
const ok = (b) => (b ? "✓" : "✗");

(async () => {
  const want = process.argv[2];
  const q = want
    ? `audit_events?target_id=eq.${want}&select=*`
    : `audit_events?action=eq.appointment_book&source=eq.booking-widget&details->>barber_slug=eq.chavez&order=created_at.desc&limit=1&select=*`;
  const [row] = await sb(q);
  if (!row) return console.log("No chavez booking through the widget yet.");
  const apptId = row.target_id;
  const summary = row.summary || "";
  console.log(`\nBooking ${apptId} — ${row.created_at.slice(0, 16)}Z\n  ${summary}\n`);

  // 1. audit
  const paid = /deposit \$[\d.]+ paid=(\S+?)[;\]]/.exec(summary);
  const failed = /FAILED|INSERT-FAILED|LEDGER-ROW-FAILED/.test(summary);
  console.log(`${ok(paid && !failed)} 1. audit: deposit charged${paid ? ` (square ${paid[1]})` : ""}${failed ? " — has a FAILED marker" : ""}`);

  // 2. ledger
  const tx = await sb(`transactions?appointment_id=eq.${apptId}&transaction_type=eq.deposit&select=gross_amount,square_payment_id,settlement_status,environment`);
  console.log(`${ok(tx.length)} 2. ledger: ${tx.length ? `$${tx[0].gross_amount} · ${tx[0].settlement_status} · ${tx[0].environment}` : "no transactions row"}`);

  // 3. appointment
  const a = await ghl(`/calendars/events/appointments/${apptId}`);
  const appt = a.appointment || a.event || {};
  console.log(`${ok(appt.appointmentStatus === "confirmed")} 3. GHL appointment: ${appt.appointmentStatus || a.message || "not found"} · ${appt.startTime || ""}`);

  // 4. SMS with trigger link
  const conv = await ghl(`/conversations/search?contactId=${row.contact_id}&locationId=${process.env.GHL_BARBER_LOCATION_ID}`, "2021-04-15");
  let sms = null;
  const c = conv.conversations?.[0];
  if (c) {
    const m = await ghl(`/conversations/${c.id}/messages?type=TYPE_SMS&limit=20`, "2021-04-15");
    sms = (m.messages?.messages || []).find(
      (x) => x.direction === "outbound" && /is confirmed!/.test(x.body || "") && /mn\.studioaz\.us\/l\//.test(x.body || "") && new Date(x.dateAdded) >= new Date(row.created_at)
    );
  }
  console.log(`${ok(sms)} 4. confirmation SMS with trigger link: ${sms ? sms.dateAdded.slice(0, 16) + "Z" : "none after the booking"}`);

  // 5. GA4: the handoff landed with deposit rows
  const day = row.created_at.slice(0, 10);
  const r = await runReport("barbershop", {
    dateRanges: [{ startDate: day, endDate: "today" }],
    dimensions: [{ name: "pageLocation" }],
    metrics: [{ name: "screenPageViews" }],
    dimensionFilter: { andGroup: { expressions: [
      { filter: { fieldName: "pageLocation", stringFilter: { matchType: "CONTAINS", value: "/confirmation?" } } },
      { filter: { fieldName: "pageLocation", stringFilter: { matchType: "CONTAINS", value: "deposit_paid=" } } },
    ] } },
  });
  const hits = r.rows || [];
  console.log(`${ok(hits.length)} 5. GA4 handoff (/confirmation with deposit_paid): ${hits.length ? hits.length + " page view(s)" : "none yet — GA4 lags 24–48h; re-run tomorrow"}\n`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
