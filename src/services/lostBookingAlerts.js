// ═══ GHL-OWNED-SMS ═══
// This service sends SMS to Lionel through the GHL barbershop
// conversations API (same path as cacheReconcileLoop's staleness alert).
// The message body lives here in the repo, not in a GHL workflow, so it
// is editable and reviewable — nothing to migrate later.
//
// ── Lost-booking alerts ────────────────────────────────────────────────
//
// A failed booking used to be invisible. On 2026-09-16 two clients hit
// the read/write booking-horizon mismatch, retried until the IP rate
// limit stopped them, and left nothing but an ip_hash — no name, no
// phone, no way to call back. The horizon bug is fixed and failure rows
// now carry what the visitor typed (`details.who`); this turns those
// rows into a text message while the client is still deciding.
//
// TWO tiers, because they mean different things:
//
//   STUCK  — the same person failed ALERT_AFTER_N times inside
//            STUCK_WINDOW_MS with no success afterward. Usually our
//            fault but not always; either way they're mid-decision and a
//            callback converts.
//   BROKE  — a single failure at a step that is NEVER the client's
//            fault: create_appointment, deposit_charge, or any row
//            carrying a GHL error. One is enough; these mean the booking
//            path itself is failing and money is on the floor.
//
// Deliberately NOT alerted on: a lone validation/turnstile failure (a
// typo, a slot someone else just took, a bot) and anything on the hidden
// `test` barber. Alert fatigue is how alerts get ignored.
//
// Suppression is the slot-claim protocol (memory:
// feedback_slot_claim_alert_pattern) against `booking_lost_alerts`:
// claiming the slot IS the write, it happens BEFORE the send, and every
// read/write error fails CLOSED. If Supabase is unreachable we send
// nothing — the SMS path shares that network, so trying would only spam.

const { createClient } = require("@supabase/supabase-js");

// ── Tunables ──────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 5 * 60 * 1000;   // how often we look
const STARTUP_GRACE_MS = 90 * 1000;       // let the app settle first
const LOOKBACK_MS = 45 * 60 * 1000;       // rows this fresh are considered
const SETTLE_MS = 4 * 60 * 1000;          // ignore the last few minutes —
                                          // someone mid-retry may still
                                          // succeed, and alerting on a
                                          // booking that lands 30s later
                                          // is worse than being late.
const STUCK_WINDOW_MS = 20 * 60 * 1000;   // "same person, same sitting"
const ALERT_AFTER_N = 3;                  // failures before STUCK fires
const SUPPRESSION_MS = 6 * 60 * 60 * 1000;// per person, per 6h

const OWNER_ALERT_CONTACT_ID = "H3NamSlW7XAiF7WVUUo8"; // Lionel (barbershop)
const SITE_FAULT_STEPS = new Set(["create_appointment", "deposit_charge"]);

let timerHandle = null;
let scanInFlight = false;
let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

/** Digits only, so "(612) 555-0134" and "+16125550134" are one person. */
function phoneKey(raw) {
  if (typeof raw !== "string") return null;
  const d = raw.replace(/\D/g, "");
  if (d.length < 10) return null;
  return d.slice(-10);
}

function personKey(details) {
  const who = details?.who || {};
  const p = phoneKey(who.phone);
  if (p) return `phone:${p}`;
  const email = typeof who.email === "string" ? who.email.trim().toLowerCase() : "";
  if (email.includes("@")) return `email:${email}`;
  return details?.ip_hash ? `ip:${details.ip_hash}` : null;
}

/** Someone we could actually call or write to. */
function isReachable(details) {
  const who = details?.who || {};
  return Boolean(phoneKey(who.phone) || (who.email || "").includes("@"));
}

function displayName(who) {
  const n = `${who?.firstName || ""} ${who?.lastName || ""}`.trim();
  return n || "Someone";
}

function whenLabel(slotISO) {
  if (!slotISO) return "a slot";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    }).format(new Date(slotISO));
  } catch { return slotISO; }
}

// Plain-English cause, so the text says something actionable rather than
// making Lionel open a dashboard to find out what "validation" meant.
function reasonLabel(step, summary) {
  const s = String(summary || "");
  if (/too far out/.test(s)) return "slot beyond the booking window";
  if (step === "turnstile") return "the bot check kept rejecting them";
  if (step === "rate_limited") return "rate-limited after retrying";
  if (step === "create_appointment") return "GHL refused the appointment";
  if (step === "deposit_charge") return "the deposit card failed";
  if (step === "validation") return "the form wouldn't validate";
  return step || "unknown";
}

/**
 * Claim the alert slot for one person. Returns true ONLY if the write
 * landed — that write is the guard, not a preceding check. Fail-closed
 * everywhere: any error means "don't send".
 */
async function claimAlertSlot(alertKey, kind, summary) {
  let supabase;
  try { supabase = getSupabase(); }
  catch { console.warn("[lostBookingAlerts] 🔇 no Supabase client — not alerting"); return false; }

  try {
    const { data, error } = await supabase
      .from("booking_lost_alerts")
      .select("last_alert_at")
      .eq("alert_key", alertKey)
      .maybeSingle();
    if (error) throw error;
    if (data?.last_alert_at) {
      const since = Date.now() - new Date(data.last_alert_at).getTime();
      if (since < SUPPRESSION_MS) {
        console.log(`[lostBookingAlerts] 🔇 suppressed ${alertKey} — alerted ${(since/60000).toFixed(0)}m ago`);
        return false;
      }
    }
  } catch (err) {
    console.warn(`[lostBookingAlerts] 🔇 read failed for ${alertKey} (${err.message || err}) — fail-closed`);
    return false;
  }

  try {
    const { error } = await supabase
      .from("booking_lost_alerts")
      .upsert(
        { alert_key: alertKey, last_alert_at: new Date().toISOString(),
          alert_kind: kind, last_summary: String(summary || "").slice(0, 300) },
        { onConflict: "alert_key" }
      );
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn(`[lostBookingAlerts] 🔇 slot claim failed for ${alertKey} (${err.message || err}) — no SMS`);
    return false;
  }
}

async function sendSMS(message) {
  try {
    const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
    if (!ghlBarber) {
      console.warn("[lostBookingAlerts] ghlBarber SDK unavailable — can't send");
      return false;
    }
    await ghlBarber.conversations.sendANewMessage({
      type: "SMS",
      contactId: OWNER_ALERT_CONTACT_ID,
      message,
    });
    console.log(`[lostBookingAlerts] 📱 sent: ${message.slice(0, 80)}…`);
    return true;
  } catch (err) {
    console.error("[lostBookingAlerts] send failed:", err.message || err);
    return false;
  }
}

/** One pass. Exported so it can be run by hand without the timer. */
async function runScan() {
  if (scanInFlight) { console.log("[lostBookingAlerts] scan already in flight — skipping tick"); return; }
  scanInFlight = true;
  try {
    const supabase = getSupabase();
    const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString();

    const { data: rows, error } = await supabase
      .from("audit_events")
      .select("created_at, action, contact_id, summary, details")
      .eq("source", "booking-widget")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true });
    if (error) throw error;

    const settleCutoff = Date.now() - SETTLE_MS;
    const fails = [], wins = [];
    for (const r of rows || []) {
      const d = r.details || {};
      if (d.barber_slug === "test") continue;
      if (r.action === "appointment_book") { wins.push(r); continue; }
      if (new Date(r.created_at).getTime() > settleCutoff) continue; // too fresh
      fails.push(r);
    }

    // Who recovered? Keyed the same way, so a success cancels their alert.
    const recoveredAt = new Map();
    for (const w of wins) {
      const k = personKey(w.details) || (w.contact_id ? `contact:${w.contact_id}` : null);
      if (k) recoveredAt.set(k, new Date(w.created_at).getTime());
    }

    const groups = new Map();
    for (const f of fails) {
      const k = personKey(f.details);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }

    let sent = 0;
    for (const [key, attempts] of groups) {
      const first = attempts[0], last = attempts[attempts.length - 1];
      const firstMs = new Date(first.created_at).getTime();

      // Recovered after they started failing? Nothing lost.
      const rec = recoveredAt.get(key);
      if (rec && rec > firstMs) continue;

      const inWindow = attempts.filter(
        (a) => new Date(a.created_at).getTime() - firstMs <= STUCK_WINDOW_MS
      );
      const siteFault = attempts.find((a) => {
        const d = a.details || {};
        return SITE_FAULT_STEPS.has(d.step_reached) || d.ghl_error;
      });

      let kind = null;
      if (siteFault) kind = "BROKE";
      else if (inWindow.length >= ALERT_AFTER_N && isReachable(last.details)) kind = "STUCK";
      if (!kind) continue;

      const src = siteFault || last;
      const d = src.details || {};
      const who = d.who || {};
      const claimed = await claimAlertSlot(key, kind, src.summary);
      if (!claimed) continue;

      const name = displayName(who);
      const phone = who.phone ? ` ${who.phone}` : "";
      const barber = d.barber_slug ? d.barber_slug[0].toUpperCase() + d.barber_slug.slice(1) : "a barber";
      // Deposit calendars get no automatic client outreach (a text can't
      // take a card), so this alert is the ONLY thing that happens — say
      // so, otherwise it reads like a duplicate of a message that went out.
      let depositNote = "";
      try {
        const { depositFor } = require("../booking/depositConfig");
        if (d.barber_slug && d.service && depositFor(d.barber_slug, d.service)?.required) {
          depositNote = " Deposit chair — no auto-text was sent, this one's yours.";
        }
      } catch { /* never let the note break the alert */ }
      const msg =
        kind === "BROKE"
          ? `⚠️ Studio AZ: a booking FAILED on our side. ${name}${phone} — ${barber}, ` +
            `${whenLabel(d.slot_iso)}. Cause: ${reasonLabel(d.step_reached, src.summary)}. ` +
            `They were not booked and got no confirmation.`
          : `⚠️ Studio AZ: lost booking. ${name}${phone} tried ${attempts.length}× for ` +
            `${barber} at ${whenLabel(d.slot_iso)} and never got through — ` +
            `${reasonLabel(d.step_reached, src.summary)}. Worth a call.${depositNote}`;

      if (await sendSMS(msg)) sent++;
    }
    if (sent) console.log(`[lostBookingAlerts] ✅ ${sent} alert(s) sent`);
  } catch (err) {
    console.error("[lostBookingAlerts] scan failed:", err.message || err);
  } finally {
    scanInFlight = false;
  }
}

function startLostBookingAlertLoop() {
  if (timerHandle) return;
  console.log(
    `[lostBookingAlerts] ▶ started — scanning every ${SCAN_INTERVAL_MS / 60000}m ` +
      `(stuck≥${ALERT_AFTER_N} in ${STUCK_WINDOW_MS / 60000}m, suppression ${SUPPRESSION_MS / 3600000}h)`
  );
  setTimeout(() => {
    runScan();
    timerHandle = setInterval(runScan, SCAN_INTERVAL_MS);
  }, STARTUP_GRACE_MS);
}

module.exports = { startLostBookingAlertLoop, runScan, personKey, phoneKey, reasonLabel };
