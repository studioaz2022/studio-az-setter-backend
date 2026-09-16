// ═══ GHL-OWNED-SMS ═══
// Sends SMS to CLIENTS (not just Lionel) through the GHL barbershop
// conversations API. Copy lives here in the repo, not in a workflow.
//
// ── Booking recovery ───────────────────────────────────────────────────
//
// When someone tries to book and can't, we text them, ask if they still
// want the slot, and book it for them if they say yes.
//
// OFF BY DEFAULT. `BOOKING_RECOVERY_ENABLED=true` is required before a
// single client message goes out — same shape as GBP_PHOTO_PUSH_ENABLED.
// Until it is set, the loop runs, logs exactly what it WOULD send, and
// sends nothing. A feature that texts real clients and books real
// appointments should not start doing either because a deploy landed.
//
// The two halves:
//
//   OFFER  (here, on a timer) — a client who failed 3+ times, never came
//          back, left a phone number, and whose slot is still free gets
//          ONE message. Never a second.
//   ACCEPT (handleRecoveryReply, called from the barbershop branch of
//          /ghl/message-webhook) — an affirmative reply re-checks the
//          slot and books it.
//
// Deliberate limits, each one load-bearing:
//
//   • DEPOSIT BARBERS GET NO CLIENT MESSAGE. Lionel's calendar takes a
//     50% deposit, which a text cannot collect, so there is nothing this
//     loop can honestly promise. He handles those himself — and already
//     has the name, number and slot, because lostBookingAlerts texts him
//     on the same trigger. (Lionel's call, 2026-09-16.)
//   • QUIET HOURS. One of the lost bookings we found happened at 00:14.
//     Texting someone in the middle of the night to rescue a haircut is
//     how a helpful message becomes a complaint.
//   • ONE OFFER PER PERSON PER WEEK, and only if they left a phone.
//   • NARROW INTENT. Only unmistakable affirmatives book. Anything else —
//     a question, a new time, a maybe — goes to Lionel as a human
//     handoff. Booking someone who did not clearly say yes is the worst
//     outcome this feature can produce, so ambiguity never books.
//   • THE SLOT IS RE-CHECKED at reply time. Between the failure and the
//     reply somebody else may have taken it.

const { createClient } = require("@supabase/supabase-js");
const { getBarber, durationMinutes, SERVICES } = require("../booking/barberDirectory");
const { depositFor } = require("../booking/depositConfig");
const { slotsForBarberService } = require("../booking/bookingRoutes");

const ENABLED = process.env.BOOKING_RECOVERY_ENABLED === "true";
const SITE_URL = process.env.BARBERSHOP_SITE_URL || "https://minneapolisbarbershop.com";
const OWNER_ALERT_CONTACT_ID = "H3NamSlW7XAiF7WVUUo8"; // Lionel

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_GRACE_MS = 120 * 1000;
const LOOKBACK_MS = 45 * 60 * 1000;
const SETTLE_MS = 6 * 60 * 1000;      // longer than the alert's: give them a
                                      // real chance to just try again first
const STUCK_WINDOW_MS = 20 * 60 * 1000;
const OFFER_AFTER_N = 3;
const OFFER_TTL_MS = 24 * 60 * 60 * 1000;
const REOFFER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const QUIET_START_HOUR = 9;           // shop time
const QUIET_END_HOUR = 20;
const SHOP_TZ = "America/Chicago";

let timerHandle = null;
let scanInFlight = false;
let _supabase = null;

function sb() {
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

function phoneKey(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

function shopHour(d = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TZ, hour: "numeric", hour12: false }).format(d)
  );
}

function withinQuietHours(d = new Date()) {
  const h = shopHour(d);
  return h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

function slotLabel(iso) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: SHOP_TZ, weekday: "long", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit",
    }).format(new Date(iso));
  } catch { return iso; }
}

async function sendSMS(contactId, message) {
  if (!ENABLED) {
    console.log(`[bookingRecovery] DRY-RUN (BOOKING_RECOVERY_ENABLED unset) → ${contactId}: ${message}`);
    return "dry-run";
  }
  try {
    const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
    if (!ghlBarber) return false;
    await ghlBarber.conversations.sendANewMessage({ type: "SMS", contactId, message });
    return true;
  } catch (err) {
    console.error("[bookingRecovery] SMS failed:", err.message || err);
    return false;
  }
}

/** Is this exact slot still bookable for this barber+service? */
async function slotStillFree(barberSlug, service, slotISO) {
  try {
    const { days } = await slotsForBarberService(barberSlug, service);
    const target = new Date(slotISO).getTime();
    for (const list of Object.values(days || {})) {
      for (const s of list || []) {
        // slotsForBarberService yields PLAIN ISO STRINGS; the HTTP route is
        // what wraps them as { t, barber } before serving. Reading `s.t`
        // here silently matched nothing, so every "yes" would have told the
        // client their slot was gone. Accept both shapes.
        const iso = typeof s === "string" ? s : s?.t;
        if (iso && new Date(iso).getTime() === target) return true;
      }
    }
    return false;
  } catch (err) {
    // Fail CLOSED: if we can't prove it's free, we don't book it.
    console.warn("[bookingRecovery] slot check failed:", err.message || err);
    return false;
  }
}

/** Find-or-create the GHL contact. Validation failures happen BEFORE the
 *  widget's own upsert, so for those there is no contact yet — only what
 *  they typed. */
async function ensureContact(who) {
  const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
  if (!ghlBarber) return null;
  const up = await ghlBarber.contacts.upsertContact({
    locationId: process.env.GHL_BARBER_LOCATION_ID,
    firstName: who.firstName || undefined,
    lastName: who.lastName || undefined,
    phone: who.phone || undefined,
    email: who.email || undefined,
    source: "website:booking-recovery",
  });
  return up?.contact?.id || up?.id || null;
}

// ── intent ────────────────────────────────────────────────────────────
// Narrow on purpose. A false positive books a stranger into a chair.
// Affirmative phrases. Matching is by REMOVAL: strip every affirmative and
// every courtesy phrase, and if nothing meaningful is left — and at least one
// affirmative was present — the reply is a plain yes. That handles "yes",
// "yes please", "yep lock it in" and "sounds good" with one rule, instead of
// trying to enumerate every combination.
const YES_PHRASES = [
  "yes", "yep", "yup", "yeah", "ya", "y", "sure", "ok", "okay", "confirm",
  "confirmed", "book it", "book", "lock it in", "lock it", "sounds good",
  "that works", "works for me", "im in", "i'm in", "lets do it", "let's do it",
  "do it", "👍", "🙏", "✅",
];
const NO_PHRASES = [
  "no", "nope", "nah", "n", "cancel", "stop", "nevermind", "never mind", "nvm",
  "no thanks", "no thank you", "all set", "im good", "i'm good",
];
// Filler that carries no instruction either way.
const COURTESY_PHRASES = [
  "please", "pls", "plz", "thanks", "thank you", "thx", "ty", "sir", "man",
  "bro", "buddy", "for sure", "absolutely", "definitely", "great", "perfect",
  "awesome", "cool", "sweet", "appreciate it", "hi", "hey", "hello",
];

// Any of these and a human reads it, however it starts — the reply is
// hedging, proposing a different time, or asking something. "yes but can we
// do Friday" is NOT consent to book Wednesday.
const HESITATION_RE =
  /\b(but|instead|actually|however|though|change|different|another|rather|maybe|if|can|could|would|what|when|where|why|how|who|else|sooner|later|earlier|reschedul\w*|move)\b|\?/i;

function stripPhrases(text, phrases) {
  let out = text, hits = 0;
  for (const p of phrases) {
    const re = new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "gi");
    out = out.replace(re, (m) => { hits++; return " "; });
  }
  return { out, hits };
}

function classifyReply(text) {
  const raw = String(text || "").trim();
  if (!raw) return "ambiguous";
  if (HESITATION_RE.test(raw)) return "ambiguous";

  const base = raw.toLowerCase().replace(/[.!,;:]+/g, " ");
  const no = stripPhrases(base, NO_PHRASES);
  const yes = stripPhrases(no.out, YES_PHRASES);
  const courtesy = stripPhrases(yes.out, COURTESY_PHRASES);
  const leftover = courtesy.out.replace(/\s+/g, "").trim();

  // Anything unaccounted for means we don't actually know what they meant.
  if (leftover) return "ambiguous";
  if (no.hits > 0) return "no";      // a "no" anywhere wins over a stray "ok"
  if (yes.hits > 0) return "yes";
  return "ambiguous";                // courtesy only — warm, but not an instruction
}

// ── OFFER ─────────────────────────────────────────────────────────────

async function runScan() {
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    const supabase = sb();
    const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const { data: rows, error } = await supabase
      .from("audit_events")
      .select("created_at, action, contact_id, summary, details")
      .eq("source", "booking-widget")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true });
    if (error) throw error;

    const settle = Date.now() - SETTLE_MS;
    const fails = [], wins = [];
    for (const r of rows || []) {
      const d = r.details || {};
      if (d.barber_slug === "test") continue;
      if (r.action === "appointment_book") { wins.push(r); continue; }
      if (new Date(r.created_at).getTime() > settle) continue;
      fails.push(r);
    }

    // phone_key rides on successes too; `who` does not. Without this the
    // "did they come back?" check never matched and we could have texted
    // someone who had already booked.
    const keyOf = (r) => r.details?.phone_key || phoneKey((r.details?.who || {}).phone);
    const wonKeys = new Set(wins.map(keyOf).filter(Boolean));

    const groups = new Map();
    for (const f of fails) {
      const k = keyOf(f);
      if (!k) continue;                       // no phone → nothing to text
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }

    for (const [key, attempts] of groups) {
      if (wonKeys.has(key)) continue;         // they got there in the end
      const firstMs = new Date(attempts[0].created_at).getTime();
      const inWindow = attempts.filter(
        (a) => new Date(a.created_at).getTime() - firstMs <= STUCK_WINDOW_MS
      );
      if (inWindow.length < OFFER_AFTER_N) continue;

      const latest = attempts[attempts.length - 1];
      const d = latest.details || {};
      const who = d.who || {};
      const slug = d.barber_slug, service = d.service, slotISO = d.slot_iso;
      if (!slug || !service || !slotISO) continue;
      if (!getBarber(slug) || !SERVICES[service]) continue;
      if (new Date(slotISO).getTime() <= Date.now()) continue;   // already past

      // DEPOSIT CALENDARS: no client message, at all.
      //
      // Lionel's chair takes 50% up front, which a text cannot collect, so
      // there is nothing this loop can honestly promise. He handles those
      // himself and already has the name, number and slot, because
      // lostBookingAlerts texts him on exactly the same trigger.
      //
      // Checked HERE, before the availability lookup and the contact
      // upsert: it is a cheap local rule and there is no reason to spend a
      // GHL round trip — or create a contact record — for someone we have
      // already decided not to text. (Lionel's call, 2026-09-16.)
      if (depositFor(slug, service)?.required) {
        console.log(`[bookingRecovery] ${slug} takes a deposit — no client outreach; lostBookingAlerts has Lionel covered`);
        continue;
      }

      // already offered recently?
      const { data: prior, error: pErr } = await supabase
        .from("booking_recovery_offers")
        .select("id, offered_at")
        .eq("phone_key", key)
        .gte("offered_at", new Date(Date.now() - REOFFER_COOLDOWN_MS).toISOString())
        .limit(1);
      if (pErr) { console.warn("[bookingRecovery] prior-offer read failed — skipping"); continue; }
      if (prior && prior.length) continue;

      if (!withinQuietHours()) {
        console.log(`[bookingRecovery] ⏰ holding offer for ${key} — outside ${QUIET_START_HOUR}:00-${QUIET_END_HOUR}:00 shop time`);
        continue;
      }
      if (!(await slotStillFree(slug, service, slotISO))) {
        console.log(`[bookingRecovery] slot gone for ${key} — no offer`);
        continue;
      }

      let contactId = latest.contact_id;
      if (!contactId) {
        try { contactId = await ensureContact(who); }
        catch (err) { console.warn("[bookingRecovery] contact upsert failed:", err.message || err); continue; }
      }
      if (!contactId) continue;

      const barber = getBarber(slug);
      const first = who.firstName || "there";
      const when = slotLabel(slotISO);

      const message =
        `Hey ${first} — it's Studio AZ. Looks like your booking with ${barber.name} for ${when} didn't go through on our end. ` +
        `That time is still open. Reply YES and I'll lock it in for you.`;

      const ttl = new Date(Date.now() + OFFER_TTL_MS).toISOString();
      // Write the offer BEFORE sending. If the write fails we don't text —
      // an offer we can't honour (no state to match the reply against) is
      // worse than silence.
      const { error: wErr } = await supabase.from("booking_recovery_offers").insert({
        contact_id: contactId, phone_key: key, barber_slug: slug, service,
        slot_iso: slotISO, duration_minutes: durationMinutes(slug, service),
        expires_at: ttl,
        status: "offered",
      });
      if (wErr) { console.warn("[bookingRecovery] offer insert failed — not texting:", wErr.message); continue; }

      const sent = await sendSMS(contactId, message);
      console.log(`[bookingRecovery] ${sent === "dry-run" ? "would offer" : "offered"} ${key} — ${slug} ${when}`);
    }
  } catch (err) {
    console.error("[bookingRecovery] scan failed:", err.message || err);
  } finally {
    scanInFlight = false;
  }
}

// ── ACCEPT ────────────────────────────────────────────────────────────

/**
 * Called from the barbershop branch of /ghl/message-webhook for EVERY
 * inbound barbershop SMS. Returns true if this message was a reply to an
 * open recovery offer and has been handled (so the caller can stop).
 */
async function handleRecoveryReply(contactId, messageText) {
  let supabase;
  try { supabase = sb(); } catch { return false; }

  let offer;
  try {
    const { data, error } = await supabase
      .from("booking_recovery_offers")
      .select("*")
      .eq("contact_id", contactId)
      .eq("status", "offered")
      .gte("expires_at", new Date().toISOString())
      .order("offered_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    offer = (data || [])[0];
  } catch (err) {
    console.warn("[bookingRecovery] offer lookup failed:", err.message || err);
    return false;
  }
  if (!offer) return false;

  const verdict = classifyReply(messageText);
  const stamp = { replied_at: new Date().toISOString(), reply_text: String(messageText || "").slice(0, 400) };

  if (verdict === "no") {
    await supabase.from("booking_recovery_offers").update({ ...stamp, status: "declined" }).eq("id", offer.id);
    await sendSMS(contactId, `No problem — we're here whenever you want in. ${SITE_URL}/book`);
    return true;
  }

  if (verdict === "ambiguous") {
    // Never book on a maybe. Hand it to Lionel with the context he needs.
    await supabase.from("booking_recovery_offers").update({ ...stamp, status: "needs_human" }).eq("id", offer.id);
    await sendSMS(
      OWNER_ALERT_CONTACT_ID,
      `⚠️ Studio AZ: recovery reply needs you. They were offered ${offer.barber_slug} ` +
        `${slotLabel(offer.slot_iso)} and replied: "${String(messageText).slice(0, 120)}". Not booked.`
    );
    return true;
  }

  // ── yes ──
  const free = await slotStillFree(offer.barber_slug, offer.service, offer.slot_iso);
  if (!free) {
    await supabase.from("booking_recovery_offers").update({ ...stamp, status: "slot_gone" }).eq("id", offer.id);
    await sendSMS(
      contactId,
      `Ah — that time just got taken. Pick any other opening here and it's yours: ` +
        `${SITE_URL}/book?barber=${offer.barber_slug}&service=${offer.service}`
    );
    return true;
  }

  try {
    const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
    const barber = getBarber(offer.barber_slug);
    const mins = offer.duration_minutes || durationMinutes(offer.barber_slug, offer.service) || 45;
    const endISO = new Date(new Date(offer.slot_iso).getTime() + mins * 60000).toISOString();

    // No `title` — GHL renders the calendar's own eventTitle template
    // (memory: ghl_appointment_title_template).
    const appt = await ghlBarber.calendars.createAppointment({
      calendarId: barber.calendarId,
      locationId: process.env.GHL_BARBER_LOCATION_ID,
      contactId,
      startTime: offer.slot_iso,
      endTime: endISO,
      description: "Booked by SMS recovery — client confirmed a slot their online booking had failed on.",
      appointmentStatus: "confirmed",
      ignoreDateRange: false,
      ignoreFreeSlotValidation: false,
      ...(barber.ghlUserId ? { assignedUserId: barber.ghlUserId } : {}),
    });
    const apptId = appt?.id || appt?.appointment?.id || null;

    await supabase.from("booking_recovery_offers")
      .update({ ...stamp, status: "accepted", appointment_id: apptId }).eq("id", offer.id);

    // The GHL confirmation workflow fires off the appointment itself, so
    // we deliberately don't send a second "you're booked" text here.
    await sendSMS(
      OWNER_ALERT_CONTACT_ID,
      `✅ Studio AZ: recovered a booking. ${barber.name} — ${slotLabel(offer.slot_iso)}. ` +
        `Client replied yes to the failed-booking text and it's on the calendar.`
    );
    console.log(`[bookingRecovery] ✅ booked ${apptId} for contact ${contactId}`);
    return true;
  } catch (err) {
    await supabase.from("booking_recovery_offers")
      .update({ ...stamp, status: "failed", note: String(err.message || err).slice(0, 300) }).eq("id", offer.id);
    await sendSMS(
      OWNER_ALERT_CONTACT_ID,
      `⚠️ Studio AZ: a client said YES to a recovery offer and the booking FAILED. ` +
        `${offer.barber_slug} ${slotLabel(offer.slot_iso)}. They are expecting it. Reason: ${String(err.message || err).slice(0, 90)}`
    );
    console.error("[bookingRecovery] booking on accept failed:", err.message || err);
    return true;
  }
}

function startBookingRecoveryLoop() {
  if (timerHandle) return;
  console.log(
    `[bookingRecovery] ▶ started — ${ENABLED ? "LIVE (will text clients)" : "DRY-RUN (set BOOKING_RECOVERY_ENABLED=true to send)"}; ` +
      `offers ≥${OFFER_AFTER_N} fails, ${QUIET_START_HOUR}:00-${QUIET_END_HOUR}:00 shop time only`
  );
  setTimeout(() => {
    runScan();
    timerHandle = setInterval(runScan, SCAN_INTERVAL_MS);
  }, STARTUP_GRACE_MS);
}

module.exports = {
  startBookingRecoveryLoop, runScan, handleRecoveryReply,
  classifyReply, withinQuietHours, phoneKey, ENABLED,
};
