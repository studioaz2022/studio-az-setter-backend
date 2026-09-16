// ─── Booking widget audit trail ───
//
// One row in Supabase `audit_events` per booking ATTEMPT — successes AND
// failures — so "my appointment didn't go through" / "double booking" /
// "never confirmed" complaints are a 30-second lookup instead of guesswork.
//
// Same append-only table the iOS AuditService writes (see
// Studio AZ Tattoo/Core/Services/AuditService.swift for the column contract).
// Query by contact_id / action / source='booking-widget'.
//
// Audit failures log loudly but NEVER block the booking response.

const crypto = require("crypto");
const { supabase } = require("../clients/supabaseClient");

const LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID;

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 16);
}

/**
 * @param {object} p
 * @param {boolean} p.success
 * @param {string} p.summary          human-readable one-liner
 * @param {string} p.stepReached      received|rate_limited|validation|turnstile|upsert_contact|create_appointment|done
 * @param {string} [p.appointmentId]
 * @param {string} [p.contactId]
 * @param {string} [p.barberSlug]
 * @param {string} [p.service]
 * @param {string} [p.slotISO]
 * @param {string} [p.ghlError]
 * @param {boolean} [p.turnstileOk]
 * @param {string} [p.ip]             raw IP — hashed before storage, never stored raw
 * @param {string[]} [p.turnstileCodes] Cloudflare siteverify error-codes, verbatim
 * @param {string} [p.phoneKey]       last 10 digits — on EVERY row, so a later
 *                                    success can be matched to an earlier failure.
 * @param {object} [p.who]            what the visitor typed — {firstName,lastName,phone,email}.
 *                                    Recorded on FAILURES so a lost booking leaves a person we
 *                                    can call back, not just an ip_hash. Audit table only —
 *                                    never GHL, so bots that fail Turnstile create no contact.
 */
async function logBookingAttempt(p) {
  if (!supabase) {
    console.warn("[bookingAudit] supabase not initialized — attempt NOT audited:", p.summary);
    return;
  }
  try {
    const row = {
      actor_ghl_id: null,
      actor_name: "Website visitor",
      actor_role: "customer",
      action: p.success ? "appointment_book" : "appointment_book_failed",
      target_type: "appointment",
      target_id: p.appointmentId || null,
      contact_id: p.contactId || null,
      summary: p.summary,
      details: {
        step_reached: p.stepReached,
        barber_slug: p.barberSlug || null,
        service: p.service || null,
        slot_iso: p.slotISO || null,
        ghl_error: p.ghlError || null,
        turnstile_ok: p.turnstileOk === undefined ? null : String(p.turnstileOk),
        turnstile_codes: p.turnstileCodes && p.turnstileCodes.length ? p.turnstileCodes : null,
        who: p.who || null,
        // Present on successes too — it is how "they failed, then booked"
        // is detected. See the note in bookingCreate.
        phone_key: p.phoneKey || null,
        ip_hash: hashIp(p.ip),
      },
      location_id: LOCATION_ID,
      source: "booking-widget",
    };
    const { error } = await supabase.from("audit_events").insert(row);
    if (error) {
      console.error("[bookingAudit] insert failed:", error.message, "| summary:", p.summary);
    }
  } catch (err) {
    console.error("[bookingAudit] unexpected failure:", err?.message, "| summary:", p.summary);
  }
}

module.exports = { logBookingAttempt };
