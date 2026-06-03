// refundRequestService.js
// Service for the Refund Request Form flow — Supabase storage, deposit lookup,
// auto-refund, GHL Lost transition, win-back tagging.
//
// Mirrors src/consentForm/consentFormService.js conventions (token-gated
// public form, Supabase as authoritative store, GHL writes on submit).
//
// Phase 1 scope: generateRefundToken (shipped).
// Phase 3 scope (this file): full lifecycle — createRefundRequest,
//   getRefundRequestByToken, submitRefundRequest — but money + Lost are
//   STUBBED. The submit endpoint persists answers only; Square refunds and
//   COLD_NURTURE_LOST transitions are wired in Phase 5.

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const {
  getContact,
  sendConversationMessage,
  addTagsToContact,
} = require("../clients/ghlClient");
const { listAppointmentsForContact } = require("../clients/ghlCalendarClient");
const { getOpportunitiesByContact } = require("../clients/ghlOpportunityClient");
const { transitionToStage } = require("../ai/opportunityManager");
const {
  OPPORTUNITY_STAGES,
  GHL_USER_IDS,
  CONSULTATION_CALENDARS,
  APPOINTMENT_STATUS,
} = require("../config/constants");
const { refundPayment } = require("../payments/squareClient");
const { recordTransaction } = require("../clients/financialTracking");
const { sendPushToGhlUser } = require("../services/taskNotifications");
const { createShortLink } = require("../payments/shortLinks");

// ---- Module-local Supabase client ----
//
// We instantiate a service-role client here (matches the rest of the backend's
// pattern — see squareClient.js, consentFormService.js). RLS is intentionally
// disabled on refund_requests; see memory: supabase_rls_convention.md.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REFUND_FORM_BASE_URL =
  process.env.REFUND_FORM_URL || "https://refund.studioaztattoo.com";

// ---- GHL custom-field IDs we read ----
//
// Conservative: we read what we need and nothing else. IDs are pulled from
// the existing CRM (verified by grepping production usage in app.js).
const GHL_FIELD_IDS = {
  // Gemini smart notes (Google consult path) — populated only after a real
  // consult call produces a structured summary.
  geminiSmartNotes: "xHbhQ2sA7r0jzMfIFMQT",
  // Fireflies "processed at" — set once a Fireflies transcript lands.
  firefliesProcessedAt: "HORoQH6waBo9xSabFbyM",
};

// Valid drop_off_stage values (mirror the DB CHECK on refund_requests).
const DROP_OFF_STAGES = Object.freeze({
  PRE_CONSULT: "pre_consult",
  CONSULT_SCHEDULED: "consult_scheduled",
  POST_CONSULT: "post_consult",
  TATTOO_BOOKED: "tattoo_booked",
});

// Reason-code enum used by both the public form and the GHL `lost_reason`
// rollup. Mirror of the §5 form spec and the DB CHECK.
const REASON_CODES = new Set([
  "not_now",
  "found_other",
  "price",
  "scheduling",
  "style_fit",
  "design_confidence",
  "consult_expectations",
  "finances",
  "personal_medical",
  "other",
]);

// Section 2 score keys (1-5 Likert, all five required when section is shown).
const CONSULT_SCORE_KEYS = [
  "q_felt_heard",
  "q_style_match",
  "q_price_clarity",
  "q_next_steps",
  "q_trust",
];

// =====================================================================
//                          Token generation
// =====================================================================

/**
 * Generate a secure single-use token for a refund-form magic link.
 *
 * 48 hex chars (192 bits of entropy → collision is impossible in practice).
 * The unique index on refund_requests.token catches any storage bug regardless.
 *
 * NOTE: Square's idempotency keys are capped at 45 chars. squareClient.refundPayment
 * truncates internally, so callers can pass this token verbatim as the refund
 * idempotency key without losing collision resistance.
 */
function generateRefundToken() {
  return crypto.randomBytes(24).toString("hex"); // 48-char token
}

// =====================================================================
//                          Helpers
// =====================================================================

/**
 * Read-only check: did this contact have a real consultation?
 *
 * Returns `{ happened: boolean, validity: 'valid' | 'low_signal' | 'unknown' }`.
 *
 * Sources, in priority order:
 *   1. Supabase `fireflies_transcripts` row with status='processed' for the contact.
 *   2. GHL Gemini smart-notes field (xHbhQ2sA7r0jzMfIFMQT) — only populated when
 *      a real consult call produces structured output.
 *   3. GHL `fireflies_processed_at` field (HORoQH6waBo9xSabFbyM).
 *
 * Validity guard (§4): a 30-second wrong-number call can produce a transcript.
 * The current `fireflies_transcripts` schema does not store sentence count or
 * duration, so we use a pragmatic time-window proxy: a 'processed' row with a
 * meeting_date older than a few hours but newer than a year is treated as a
 * real consult. Anything just-created (< 6 hours old) is marked low_signal
 * because the processing may still be in flight. Future phase: tighten this
 * once we capture transcript metadata.
 */
async function consultDidHappen(contactId, contact = null) {
  if (!contactId) return { happened: false, validity: "unknown" };

  // 0. PRIMARY signal — GHL appointment status.
  //
  // The most authoritative check: did the contact actually have a
  // consultation appointment that's now in the past, and was it NOT
  // cancelled or marked no-show? Anything else (status="new"/"confirmed"/
  // "showed" with a past startTime, no late edits flipping it to cancelled)
  // counts as "happened" — staff didn't mark it no-show, so we assume it
  // happened, per owner direction (refund-form Phase X UX rebuild 2026-06-03).
  //
  // We filter to CONSULTATION_CALENDARS specifically — tattoo-appointment
  // calendars don't count as "consult" for the purpose of the consult-quality
  // Likert. We don't include translator calendars (Lionel/Maria online) here
  // because those aren't artist consults.
  const consultCalendarIds = new Set(Object.values(CONSULTATION_CALENDARS));
  const skippedStatuses = new Set([
    APPOINTMENT_STATUS.CANCELLED, // "cancelled"
    APPOINTMENT_STATUS.NOSHOW,    // "noshow"
    APPOINTMENT_STATUS.INVALID,   // "invalid"
    // Also catch the case-variants we've seen in webhook payloads.
    "Cancelled",
    "Noshow",
    "no_show",
    "no-show",
  ]);
  try {
    const events = await listAppointmentsForContact(contactId);
    const now = Date.now();
    const validConsult = (events || []).find((evt) => {
      const calId = evt.calendarId || evt.calendar_id;
      if (!consultCalendarIds.has(calId)) return false;
      const start = evt.startTime || evt.start_time;
      if (!start) return false;
      if (new Date(start).getTime() > now) return false; // future appt
      const status = evt.appointmentStatus || evt.appoinmentStatus || evt.status;
      if (skippedStatuses.has(status)) return false;
      return true;
    });
    if (validConsult) {
      return { happened: true, validity: "valid" };
    }
    // If we successfully fetched appointments AND none qualify, treat this
    // as the authoritative "no" — but still fall through to Fireflies/Gemini
    // below in case the appointment was deleted but the consult clearly
    // happened (rare but possible).
  } catch (err) {
    console.warn(
      `[refundRequest] consultDidHappen GHL appointments fetch failed for ${contactId}: ${err.message}`
    );
    // Fall through — don't fail the derivation on a transient GHL hiccup.
  }

  // 1. Secondary signal — Fireflies transcript in Supabase.
  try {
    const { data: rows, error } = await supabase
      .from("fireflies_transcripts")
      .select("status, meeting_date, processed_at")
      .eq("contact_id", contactId)
      .eq("status", "processed")
      .is("deleted_at", null)
      .limit(1);

    if (!error && rows && rows.length > 0) {
      const row = rows[0];
      const meetingDate = row.meeting_date ? new Date(row.meeting_date) : null;
      const now = Date.now();
      // Validity bounds: 6 hours old (give processing time) to 1 year old.
      const minAgeMs = 6 * 60 * 60 * 1000;
      const maxAgeMs = 365 * 24 * 60 * 60 * 1000;
      const ageMs = meetingDate ? now - meetingDate.getTime() : null;
      let validity;
      if (ageMs == null) {
        validity = "low_signal"; // missing meeting_date → can't validate
      } else if (ageMs < minAgeMs) {
        validity = "low_signal";
      } else if (ageMs > maxAgeMs) {
        validity = "low_signal";
      } else {
        validity = "valid";
      }
      return { happened: validity === "valid", validity };
    }
  } catch (err) {
    console.warn(
      `[refundRequest] consultDidHappen Supabase lookup failed for ${contactId}: ${err.message}`
    );
    // Fall through to GHL custom fields — don't fail the whole derivation.
  }

  // 2 + 3. GHL custom fields. Re-use a contact record if the caller already
  // has one, otherwise fetch.
  let cf = null;
  try {
    const contactRecord = contact || (await getContact(contactId));
    cf = contactRecord?.customField || contactRecord?.customFields || {};
  } catch (err) {
    console.warn(
      `[refundRequest] consultDidHappen GHL fetch failed for ${contactId}: ${err.message}`
    );
    return { happened: false, validity: "unknown" };
  }

  const geminiNotes = cf[GHL_FIELD_IDS.geminiSmartNotes];
  if (geminiNotes && String(geminiNotes).trim().length > 50) {
    // Gemini only writes structured notes after a real consult — 50 chars is a
    // conservative floor (any genuine summary will easily exceed it).
    return { happened: true, validity: "valid" };
  }

  const firefliesProcessedAt = cf[GHL_FIELD_IDS.firefliesProcessedAt];
  if (firefliesProcessedAt) {
    return { happened: true, validity: "valid" };
  }

  return { happened: false, validity: "unknown" };
}

/**
 * Look up the current opportunity for a contact WITHOUT side-effects.
 *
 * Unlike opportunityManager.ensureOpportunity, this never creates an
 * opportunity — refunds are a Lost-pipeline event, not a funnel entry.
 *
 * Returns `{ opportunityId, currentStage }` (both may be null).
 */
async function readOpportunityState(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  // GHL syncs these into the contact's custom fields whenever the pipeline moves.
  let opportunityId = cf.opportunity_id || null;
  let currentStage = cf.opportunity_stage || null;

  if (opportunityId && currentStage) {
    return { opportunityId, currentStage };
  }

  // Fall back to the live opportunity list — same source the pipeline uses.
  try {
    const contactId = contact?.id;
    if (!contactId) return { opportunityId, currentStage };
    const opps = await getOpportunitiesByContact({ contactId });
    const first = opps?.[0];
    if (first) {
      opportunityId = first.id || first._id || opportunityId;
      // Live stages from GHL come back as a stage ID, not the OPPORTUNITY_STAGES
      // key. Mapping back is opportunityManager's job; for our purposes we use
      // whatever the contact field says (kept in sync by transitionToStage). If
      // we got here via the fallback, the stage is unknowable from this call
      // alone — return null and let downstream default to pre_consult.
    }
  } catch (err) {
    console.warn(
      `[refundRequest] readOpportunityState fallback failed: ${err.message}`
    );
  }

  return { opportunityId, currentStage };
}

/**
 * Map (currentStage, consultHappened) → drop_off_stage.
 *
 *  pre_consult       — pre-funnel signups or Deposit Pending/Paid w/o booked consult
 *  consult_scheduled — consult booked but no valid transcript yet
 *  post_consult      — consult happened, tattoo not yet booked
 *  tattoo_booked     — tattoo appointment locked
 *
 * Per §4: when consult completion is uncertain, default to consult_scheduled
 * (Section 2 hidden) rather than showing consult-quality questions wrongly.
 */
function deriveDropOffStage({ currentStage, consultHappened }) {
  const stage = currentStage || "";

  // Highest priority: explicit tattoo booking.
  if (stage === "TATTOO_BOOKED") return DROP_OFF_STAGES.TATTOO_BOOKED;

  // Consult stages — Fireflies/Gemini is the source of truth for "did it happen".
  if (stage === "CONSULT_APPOINTMENT" || stage === "CONSULT_MESSAGE") {
    return consultHappened
      ? DROP_OFF_STAGES.POST_CONSULT
      : DROP_OFF_STAGES.CONSULT_SCHEDULED;
  }

  // Pre-funnel / pre-deposit stages — they never got to a consult.
  if (
    stage === "INTAKE" ||
    stage === "DISCOVERY" ||
    stage === "DEPOSIT_PENDING" ||
    stage === "QUALIFIED"
  ) {
    // Edge case: the consult could have happened but the pipeline lagged.
    // If Fireflies says yes, trust Fireflies — it's the §4 source of truth.
    return consultHappened
      ? DROP_OFF_STAGES.POST_CONSULT
      : DROP_OFF_STAGES.PRE_CONSULT;
  }

  // Unknown stage → safest default: hide Section 2.
  return consultHappened
    ? DROP_OFF_STAGES.POST_CONSULT
    : DROP_OFF_STAGES.PRE_CONSULT;
}

/**
 * Whether Section 2 (consult quality) should render on the form.
 * Encapsulated so the GET endpoint never leaks the raw drop_off_stage.
 */
function showConsultQualityFor(dropOffStage) {
  return (
    dropOffStage === DROP_OFF_STAGES.POST_CONSULT ||
    dropOffStage === DROP_OFF_STAGES.TATTOO_BOOKED
  );
}

/**
 * Find the contact's paid deposit(s) — deposits only, per decision #2.
 *
 * Uses the Phase 0.5 `payment_type='deposit'` tag (amount-agnostic), and
 * filters historical rows by the safe-amount policy from Phase 0:
 *   - $100 (10000c) auto-refundable (unambiguous large-tattoo deposit)
 *   - $50  (5000c)  ambiguous → exclude from auto path (forces manual review)
 *   - $25  (2500c)  consult fee → exclude entirely
 *
 * Returns:
 *   { single: { square_payment_id, amount_cents, currency } } when exactly 1 found
 *   { multi: true, candidates: [...] }                         when 2+ found
 *   { missing: true }                                          when 0 found
 */
async function locatePaidDeposit(contactId) {
  const { data: rows, error } = await supabase
    .from("checkout_sessions")
    .select(
      "id, square_payment_id, amount_cents, currency, payment_type, paid_at, title"
    )
    .eq("contact_id", contactId)
    .eq("status", "paid")
    .eq("business", "tattoo")
    .eq("payment_type", "deposit")
    .not("square_payment_id", "is", null)
    .order("paid_at", { ascending: false });

  if (error) {
    console.error(
      `[refundRequest] locatePaidDeposit error for ${contactId}: ${error.message}`
    );
    // Treat lookup failure as "missing" — Phase 5 will route to manual review.
    return { missing: true };
  }

  const safeRows = (rows || []).filter((r) => {
    // $25 is unambiguously a consult fee in every tier — never refund.
    if (r.amount_cents <= 2500) return false;
    return true;
  });

  if (safeRows.length === 0) return { missing: true };
  if (safeRows.length === 1) {
    const r = safeRows[0];
    return {
      single: {
        square_payment_id: r.square_payment_id,
        amount_cents: r.amount_cents,
        currency: r.currency || "USD",
        checkout_session_id: r.id,
      },
    };
  }

  return {
    multi: true,
    candidates: safeRows.map((r) => ({
      square_payment_id: r.square_payment_id,
      amount_cents: r.amount_cents,
      currency: r.currency || "USD",
      checkout_session_id: r.id,
      paid_at: r.paid_at,
    })),
  };
}

// =====================================================================
//                          createRefundRequest
// =====================================================================

/**
 * Mint a refund-request token for `contactId`, snapshot the state, and SMS
 * the magic link to the client.
 *
 * Idempotent on the contact: if a pending (non-expired) refund request
 * already exists, returns the existing token instead of creating a new one.
 * This prevents two outstanding tokens that could both submit and double-trip
 * Square refund logic (Square's idempotency saves the money but the second
 * submit looks like a failure to the user).
 *
 * Returns `{ success: true, token, url, reused: bool }` on success, or
 * `{ success: false, error }` otherwise.
 */
async function createRefundRequest(contactId) {
  if (!contactId) {
    return { success: false, error: "contactId is required" };
  }

  // 1. Read GHL contact + opportunity (no side-effects).
  let contact;
  try {
    contact = await getContact(contactId);
  } catch (err) {
    return { success: false, error: `Failed to fetch contact: ${err.message}` };
  }
  if (!contact) {
    return { success: false, error: "Contact not found" };
  }

  const phone = contact.phone;
  if (!phone) {
    return {
      success: false,
      error: "Contact has no phone number — refund link cannot be sent",
    };
  }

  const firstName = contact.firstName || contact.first_name || "there";
  const cf = contact.customField || contact.customFields || {};
  const langPref = cf.language_preference || "english";
  const isSpanish =
    String(langPref).toLowerCase().includes("span") ||
    String(langPref).toLowerCase() === "es";
  const language = isSpanish ? "es" : "en";

  // 2. Idempotency: reuse a pending, non-expired request for the same contact.
  try {
    const { data: existingRows, error: existingErr } = await supabase
      .from("refund_requests")
      .select("token, expires_at, status")
      .eq("contact_id", contactId)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1);

    if (!existingErr && existingRows && existingRows.length > 0) {
      const existing = existingRows[0];
      const url = `${REFUND_FORM_BASE_URL}/r/${existing.token}`;
      console.log(
        `[refundRequest] Reusing existing pending token for ${contactId}: ${existing.token.slice(0, 8)}…`
      );
      return { success: true, token: existing.token, url, reused: true };
    }
  } catch (err) {
    // Non-fatal: if the dedup check fails we'd rather mint a new token than
    // refuse to send. The unique-by-token DB index still catches collisions.
    console.warn(
      `[refundRequest] dedup check failed for ${contactId}: ${err.message}`
    );
  }

  // 3. Derive drop_off_stage from current GHL state + Fireflies.
  const { opportunityId, currentStage } = await readOpportunityState(contact);
  const { happened: consultHappened, validity: consultValidity } =
    await consultDidHappen(contactId, contact);
  const dropOffStage = deriveDropOffStage({
    currentStage,
    consultHappened,
  });

  // 4. Locate the deposit — single / multi / missing branches.
  const deposit = await locatePaidDeposit(contactId);

  let square_payment_id = null;
  let refund_amount_cents = null;
  let currency = "USD";
  let multi_or_missing_deposit = false;
  let candidate_payment_ids = null;
  let refund_status = "not_attempted";

  if (deposit.single) {
    square_payment_id = deposit.single.square_payment_id;
    refund_amount_cents = deposit.single.amount_cents;
    currency = deposit.single.currency;
  } else if (deposit.multi) {
    multi_or_missing_deposit = true;
    candidate_payment_ids = deposit.candidates;
    refund_status = "manual_review";
  } else if (deposit.missing) {
    multi_or_missing_deposit = true;
    refund_status = "manual_review";
  }

  // 5. Insert the refund_requests row. Token uniqueness retried on rare
  // collision (impossible in practice; defensive).
  let token = generateRefundToken();
  let insertedRow = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from("refund_requests")
      .insert({
        token,
        contact_id: contactId,
        opportunity_id: opportunityId,
        language,
        drop_off_stage: dropOffStage,
        square_payment_id,
        refund_amount_cents,
        currency,
        multi_or_missing_deposit,
        candidate_payment_ids,
        consult_validity: consultValidity,
        refund_status,
      })
      .select()
      .single();

    if (!error) {
      insertedRow = data;
      break;
    }

    // 23505 = unique_violation — retry with a fresh token.
    if (error.code === "23505" && error.message.includes("token")) {
      token = generateRefundToken();
      continue;
    }

    console.error(
      `[refundRequest] insert error for ${contactId}: ${error.message}`
    );
    return { success: false, error: error.message };
  }

  if (!insertedRow) {
    return { success: false, error: "Failed to mint refund token" };
  }

  // 6. Send SMS. Failure here should NOT roll back the row — staff can resend.
  const longUrl = `${REFUND_FORM_BASE_URL}/r/${token}`;

  // Shorten via the existing pay.studioaztattoo.com short-link table — but
  // serve it under refund.studioaztattoo.com/s/<code> via a Vercel rewrite,
  // so the host name the client sees matches the action ("refund").
  // Non-fatal: if shortening fails for any reason, fall back to the long
  // URL — the SMS still works, just longer. We never block the refund flow
  // on cosmetic shortening.
  let shareUrl = longUrl;
  try {
    const { code } = await createShortLink(longUrl, null);
    shareUrl = `${REFUND_FORM_BASE_URL}/s/${code}`;
  } catch (err) {
    console.warn(
      `[refundRequest] short-link mint failed for ${contactId}: ${err.message} — falling back to long URL`
    );
  }

  const smsBody = isSpanish
    ? `Hola ${firstName}, lamentamos que no podamos seguir adelante. Por favor completa este formulario corto para procesar tu reembolso: ${shareUrl}`
    : `Hi ${firstName}, we're sorry it didn't work out. Please complete this short form to process your refund: ${shareUrl}`;

  try {
    await sendConversationMessage({
      contactId,
      body: smsBody,
      channelContext: { hasPhone: true, phone },
    });
    console.log(
      `[refundRequest] Sent refund link to ${firstName} (${contactId}), stage=${dropOffStage}, deposit=${deposit.single ? "single" : deposit.multi ? "multi" : "missing"}`
    );
  } catch (err) {
    console.warn(
      `[refundRequest] SMS send failed for ${contactId}: ${err.message}`
    );
    // Row exists; caller can retry. Surface a non-fatal warning to the API.
    return {
      success: true,
      token,
      url: shareUrl,
      reused: false,
      smsWarning: err.message,
    };
  }

  return { success: true, token, url: shareUrl, reused: false };
}

// =====================================================================
//                       getRefundRequestByToken
// =====================================================================

/**
 * Public prefill endpoint backing GET /api/refund-request/:token.
 *
 * Returns the minimal payload the form needs to render — never exposes the
 * raw drop_off_stage or the deposit amount-cents path. If the request is
 * expired we lazy-update the row to status='expired' here.
 *
 * Outcomes:
 *   { success: true, data: { firstName, language, showConsultQuality, refundAmountCents, currency } }
 *   { success: false, error: 'not_found' }              → 404
 *   { success: false, error: 'expired', expired: true } → 410
 *   { success: false, error: 'already_submitted' }      → 410
 */
async function getRefundRequestByToken(token) {
  if (!token || typeof token !== "string") {
    return { success: false, error: "not_found" };
  }

  const { data: row, error } = await supabase
    .from("refund_requests")
    .select(
      "id, token, contact_id, language, drop_off_stage, refund_amount_cents, currency, status, expires_at"
    )
    .eq("token", token)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[refundRequest] GET token error: ${error.message}`);
    return { success: false, error: "internal" };
  }
  if (!row) {
    return { success: false, error: "not_found" };
  }

  if (row.status === "completed") {
    return { success: false, error: "already_submitted" };
  }

  // Lazy-expire if past expires_at.
  const isExpired =
    row.status === "expired" ||
    (row.expires_at && new Date(row.expires_at).getTime() < Date.now());
  if (isExpired) {
    if (row.status !== "expired") {
      await supabase
        .from("refund_requests")
        .update({ status: "expired" })
        .eq("token", token)
        .eq("status", "pending");
    }
    return { success: false, error: "expired", expired: true };
  }

  // Pull the contact's first name for the prefill. We deliberately fetch
  // GHL fresh here rather than snapshotting on send: the form is opened later
  // and a name update should reflect. Failure → fall back to "there".
  let firstName = "there";
  try {
    const contact = await getContact(row.contact_id);
    firstName =
      contact?.firstName ||
      contact?.first_name ||
      contact?.contactName ||
      "there";
  } catch (err) {
    console.warn(
      `[refundRequest] prefill name fetch failed: ${err.message}`
    );
  }

  return {
    success: true,
    data: {
      firstName,
      language: row.language || "en",
      showConsultQuality: showConsultQualityFor(row.drop_off_stage),
      refundAmountCents: row.refund_amount_cents,
      currency: row.currency || "USD",
    },
  };
}

// =====================================================================
//                       Phase 5 helpers (money + CRM + notifications)
// =====================================================================

/**
 * Push an APNs alert to BOTH the owner (Lionel) and the admin (Maria) when a
 * refund needs manual review (§6.5). Reasons we escalate:
 *   - multi/missing deposit detected at /send time
 *   - Square refund call failed
 *
 * Failure-soft: a push delivery error must NEVER prevent the submit from
 * succeeding — the money side already settled (or is on its way) and the
 * user-facing form needs to terminate.
 */
async function notifyRefundManualReview({ contactId, contactName, reason }) {
  const safeName = contactName || "Unknown client";
  const recipients = [GHL_USER_IDS.LIONEL, GHL_USER_IDS.MARIA].filter(Boolean);
  for (const ghlUserId of recipients) {
    try {
      await sendPushToGhlUser(ghlUserId, (language) => {
        const isEs = language === "es";
        return {
          type: "refund_manual_review",
          title: isEs ? "Reembolso requiere revisión" : "Refund needs review",
          body: isEs
            ? `${safeName}: ${reason}. Procesa el reembolso manualmente.`
            : `${safeName}: ${reason}. Process this refund manually.`,
          contactId,
        };
      });
    } catch (err) {
      console.warn(
        `[refundRequest] manual-review push to ${ghlUserId} failed: ${err.message}`
      );
    }
  }
}

/**
 * Look up the original deposit's `transactions` row by its
 * `square_payment_id`. We need it for two reasons:
 *   1. So the refund row carries the EXACT split the deposit recorded — a
 *      commission-rate change between deposit and refund would otherwise leave
 *      `netToArtist` skewed (Phase 2 just sums whatever is on the rows).
 *   2. So we can copy `artist_ghl_id` + `location_id` onto the refund row.
 *
 * Returns null if no row found — caller logs and skips the ledger mirror.
 */
async function lookupOriginalDepositTxn(squarePaymentId) {
  if (!squarePaymentId) return null;
  const { data, error } = await supabase
    .from("transactions")
    .select(
      "id, contact_id, contact_name, artist_ghl_id, gross_amount, shop_amount, artist_amount, shop_percentage, artist_percentage, location_id, payment_method"
    )
    .eq("square_payment_id", squarePaymentId)
    .is("superseded_by", null)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(
      `[refundRequest] original deposit lookup failed for ${squarePaymentId}: ${error.message}`
    );
    return null;
  }
  return data;
}

/**
 * Post the refund as a NEW positive-gross `transaction_type:'refund'` row
 * (§6.7). Mirrors the deposit's split exactly via the recordTransaction
 * override path so the Phase 2 reconciliation engine nets correctly.
 *
 * Returns the inserted row or null on failure (failure does NOT roll back the
 * Square refund — the money has already moved; the row can be backfilled
 * later from the `refund.updated` webhook or by hand).
 */
async function postRefundLedgerRow({
  refundedTxn,
  contactName,
  squareRefundId,
  refundAmountCents,
}) {
  if (!refundedTxn) return null;
  const grossAmountDollars = refundAmountCents / 100;
  try {
    return await recordTransaction({
      contactId: refundedTxn.contact_id,
      contactName: contactName || refundedTxn.contact_name || "Unknown",
      artistId: refundedTxn.artist_ghl_id,
      transactionType: "refund",
      paymentMethod: "square",
      paymentRecipient: "shop",
      grossAmount: grossAmountDollars,
      // §6.7 gotcha #3: refund row stores the Square REFUND id, NOT the
      // original payment id. The (square_payment_id, location_id) unique
      // index would collide otherwise.
      squarePaymentId: squareRefundId,
      locationId: refundedTxn.location_id,
      sessionDate: new Date().toISOString(),
      notes: `Refund ${squareRefundId} for deposit payment ${refundedTxn.id} — refund form`,
      // §5.4 override bundle: mirror the deposit's split exactly so a
      // commission-rate change between deposit and refund doesn't skew
      // netToArtist.
      shopPercentageOverride: Number(refundedTxn.shop_percentage),
      artistPercentageOverride: Number(refundedTxn.artist_percentage),
      shopAmountOverride: Number(refundedTxn.shop_amount),
      artistAmountOverride: Number(refundedTxn.artist_amount),
    });
  } catch (err) {
    console.error(
      `[refundRequest] postRefundLedgerRow failed for refund ${squareRefundId}: ${err.message}`
    );
    return null;
  }
}

/**
 * Mirror the refund into InstantDB (rent-tracker) as a `refund` service-income
 * row with **negative** amount so the tile aggregates net out (§6.7).
 *
 * The existing writeServiceIncome guards on Lionel — non-Lionel deposits are
 * never mirrored in the first place, so the refund row likewise skips.
 * Failure here is non-fatal; logged and ignored.
 */
async function mirrorRefundToInstantDb({
  refundedTxn,
  refundAmountCents,
  squareRefundId,
}) {
  if (!refundedTxn) return { skipped: "no-original-txn" };
  try {
    const { writeServiceIncome } = require("../rentTracker/serviceIncomeWriter");
    return await writeServiceIncome({
      senderName: refundedTxn.contact_name || "Unknown",
      // Negative so the tile aggregate (sum of amounts) nets out the original
      // deposit row. The rent-tracker frontend will need Phase 7 rendering
      // changes to show this nicely; for now the SUM is correct.
      amount: -(refundAmountCents / 100),
      method: "square",
      type: "refund",
      paidAt: new Date(),
      notes: `Refund ${squareRefundId} for deposit payment ${refundedTxn.id}`,
      // Use the Square REFUND id for dedup so a retry doesn't double-write.
      squarePaymentId: squareRefundId,
      // Heuristic: tattoo location. Phase 7 may need a broader mapping.
      location: "tattoo",
      barberGhlId: refundedTxn.artist_ghl_id,
    });
  } catch (err) {
    console.warn(
      `[refundRequest] InstantDB mirror failed for refund ${squareRefundId}: ${err.message}`
    );
    return { skipped: "error", error: err.message };
  }
}

/**
 * Move the opportunity to COLD_NURTURE_LOST with the §6.6 analytics fields,
 * and seed the winback tag if the client opted in. Wrapped in independent
 * try/catch blocks so a GHL hiccup on Lost-transition doesn't kill the
 * winback tag write (or vice versa).
 *
 * Returns { lostMoved: bool, winbackTagged: bool } purely for logging.
 */
async function postLostTransitionAndWinback({
  contactId,
  refundRow,
  reasonCode,
  refundType,
  winbackOptIn,
  winbackEarliestMonth,
}) {
  let lostMoved = false;
  let winbackTagged = false;

  // Lost transition (§6.4 + §6.6).
  try {
    const result = await transitionToStage(
      contactId,
      OPPORTUNITY_STAGES.COLD_NURTURE_LOST,
      {
        allowRegression: true,
        lastStageBeforeLostOverride: mapDropOffToLastStage(refundRow.drop_off_stage),
        lostReason: mapReasonCodeToLostReason(reasonCode),
        refundType,
      }
    );
    lostMoved = !!result?.opportunityId;
  } catch (err) {
    console.error(
      `[refundRequest] COLD_NURTURE_LOST transition failed for ${contactId}: ${err.message}`
    );
  }

  // Win-back tag (§6.4). Only if the client opted in AND supplied a month.
  if (winbackOptIn && winbackEarliestMonth) {
    try {
      await addTagsToContact(contactId, [`winback-${winbackEarliestMonth}`]);
      winbackTagged = true;
    } catch (err) {
      console.warn(
        `[refundRequest] winback tag failed for ${contactId}: ${err.message}`
      );
    }
  }

  return { lostMoved, winbackTagged };
}

// =====================================================================
//                       submitRefundRequest (Phase 5)
// =====================================================================

/**
 * Phase 5: persist answers, refund the deposit, mirror the ledger, move the
 * opportunity to Lost, seed the win-back tag. Multi/missing deposit path
 * skips the Square call and notifies the owner + admin instead.
 *
 * Failure isolation (carefully):
 *   - Money side (Square refund + ledger row): mandatory; failure → refund_status=failed
 *     + manual-review push. We still mark status='completed' (the form ran;
 *     the user gets a real response) and the owner reconciles by hand.
 *   - CRM side (Lost transition + winback tag + InstantDB mirror): best-effort;
 *     wrapped in per-call try/catches inside the helpers. A GHL hiccup never
 *     blocks the response.
 *   - Double-submit guard: an initial CAS update sets status='completed' before
 *     any side effects. A concurrent submit hits the CAS and returns 410.
 *     Square's own idempotency-key dedup means even if the CAS race were lost,
 *     the same token would produce the same refund (not two).
 *
 * Returns the form-facing payload: { refundStatus, showRefundPath, refundAmountCents }.
 */
async function submitRefundRequest(token, answers, requestMeta = {}) {
  if (!token || typeof token !== "string") {
    return { success: false, error: "not_found", httpStatus: 404 };
  }

  // 1. Validate payload.
  const errors = validateSubmission(answers);
  if (errors.length > 0) {
    return { success: false, error: errors.join("; "), httpStatus: 400 };
  }

  // 2. Read the row — we need contact_id + square_payment_id + multi flag.
  const { data: row, error: readErr } = await supabase
    .from("refund_requests")
    .select(
      "id, status, contact_id, drop_off_stage, refund_amount_cents, multi_or_missing_deposit, expires_at, square_payment_id, currency"
    )
    .eq("token", token)
    .limit(1)
    .maybeSingle();

  if (readErr) {
    console.error(`[refundRequest] submit read error: ${readErr.message}`);
    return { success: false, error: "internal", httpStatus: 500 };
  }
  if (!row) {
    return { success: false, error: "not_found", httpStatus: 404 };
  }
  if (row.status === "completed") {
    return { success: false, error: "already_submitted", httpStatus: 410 };
  }
  if (
    row.status === "expired" ||
    (row.expires_at && new Date(row.expires_at).getTime() < Date.now())
  ) {
    return { success: false, error: "expired", httpStatus: 410 };
  }

  // 3. Build the analytics rollup fields (§6.6).
  const last_stage_before_lost = mapDropOffToLastStage(row.drop_off_stage);
  const lost_reason = mapReasonCodeToLostReason(answers.reason_code);

  // 4. CAS update #1 — claim the row by flipping status='completed' and storing
  // answers. This is the double-submit guard. refund_status stays
  // 'not_attempted' / 'manual_review' (from /send) until the money side resolves.
  const now = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from("refund_requests")
    .update({
      reason_code: answers.reason_code,
      reason_other_text: answers.reason_other_text || null,
      consult_scores: answers.consult_scores || null,
      improvement_text: answers.improvement_text || null,
      winback_opt_in: answers.winback_opt_in ?? null,
      winback_earliest_month: answers.winback_earliest_month || null,
      last_stage_before_lost,
      lost_reason,
      submitted_ip: requestMeta.ip || null,
      submitted_user_agent: requestMeta.userAgent || null,
      submitted_at: now,
      status: "completed",
    })
    .eq("token", token)
    .eq("status", "pending")
    .select()
    .maybeSingle();

  if (claimErr) {
    console.error(`[refundRequest] submit CAS error: ${claimErr.message}`);
    return { success: false, error: "internal", httpStatus: 500 };
  }
  if (!claimed) {
    return { success: false, error: "already_submitted", httpStatus: 410 };
  }

  console.log(
    `[refundRequest] Submit claimed — token=${token.slice(0, 8)}… stage=${row.drop_off_stage} multi/missing=${row.multi_or_missing_deposit}`
  );

  // Resolve a display name once for downstream logging / pushes. Non-blocking.
  let contactName = "Client";
  try {
    const contact = await getContact(row.contact_id);
    contactName =
      contact?.firstName ||
      contact?.first_name ||
      contact?.contactName ||
      contactName;
  } catch (_) {
    /* non-fatal */
  }

  // ===================================================================
  //   BRANCH A — multi/missing deposit → manual review (§6.5)
  // ===================================================================
  if (row.multi_or_missing_deposit) {
    const reason = row.square_payment_id
      ? "multiple paid deposits"
      : "no deposit on file";

    // Lost transition + winback FIRST so the analytics still fire even if the
    // push delivery flakes.
    await postLostTransitionAndWinback({
      contactId: row.contact_id,
      refundRow: row,
      reasonCode: answers.reason_code,
      // No refund_type until the owner settles by hand. Plan §6.6 says leave
      // null on the manual-review path until settlement.
      refundType: null,
      winbackOptIn: answers.winback_opt_in,
      winbackEarliestMonth: answers.winback_earliest_month,
    });

    // Notify owner + admin via APNs (§6.5).
    await notifyRefundManualReview({
      contactId: row.contact_id,
      contactName,
      reason,
    });

    return {
      success: true,
      data: {
        refundStatus: "manual_review",
        showRefundPath: false,
        refundAmountCents: row.refund_amount_cents,
      },
    };
  }

  // ===================================================================
  //   BRANCH B — single-deposit auto path
  // ===================================================================

  // Snapshot the original deposit txn FIRST so we have its commission split
  // even if the Square call later succeeds and we crash mid-flight.
  const originalTxn = await lookupOriginalDepositTxn(row.square_payment_id);
  if (!originalTxn) {
    // The deposit exists in checkout_sessions (Phase 3 confirmed it at /send)
    // but its mirror ledger row is missing. This is an edge case — escalate.
    console.error(
      `[refundRequest] No ledger row for original deposit ${row.square_payment_id} (token=${token.slice(0, 8)}…)`
    );
  }

  let squareRefundId = null;
  let refundStatus = "failed";
  let refundType = null;

  try {
    const refund = await refundPayment({
      paymentId: row.square_payment_id,
      amountCents: row.refund_amount_cents,
      idempotencyKey: token, // helper truncates to 45 chars
      currency: row.currency || "USD",
      reason: `Refund form — ${answers.reason_code}`,
    });
    squareRefundId = refund.refundId;
    refundStatus = "refunded"; // PENDING and COMPLETED both count as success
    refundType = "deposit_refunded";
  } catch (squareErr) {
    console.error(
      `[refundRequest] Square refund failed for ${row.square_payment_id}: ${squareErr.message}`
    );
    refundStatus = "failed";
    // Notify owner + admin — they need to retry manually.
    await notifyRefundManualReview({
      contactId: row.contact_id,
      contactName,
      reason: `Square refund failed: ${squareErr.message}`,
    });
  }

  // Money moved → mirror it. Failure here is logged; the row can be
  // reconciled by the (optional) refund.updated webhook later.
  if (refundStatus === "refunded" && squareRefundId && originalTxn) {
    await postRefundLedgerRow({
      refundedTxn: originalTxn,
      contactName,
      squareRefundId,
      refundAmountCents: row.refund_amount_cents,
    });
    await mirrorRefundToInstantDb({
      refundedTxn: originalTxn,
      refundAmountCents: row.refund_amount_cents,
      squareRefundId,
    });
  }

  // Lost transition + winback tag — best-effort.
  await postLostTransitionAndWinback({
    contactId: row.contact_id,
    refundRow: row,
    reasonCode: answers.reason_code,
    refundType,
    winbackOptIn: answers.winback_opt_in,
    winbackEarliestMonth: answers.winback_earliest_month,
  });

  // Final UPDATE — record the refund outcome onto the request row.
  await supabase
    .from("refund_requests")
    .update({
      refund_status: refundStatus,
      refund_type: refundType,
      square_refund_id: squareRefundId,
    })
    .eq("token", token);

  return {
    success: true,
    data: {
      // refundStatus shape exposed to the form. PENDING and COMPLETED look the
      // same to the user ("on its way"); failure shows a "we'll follow up"
      // success page (never an error — money may or may not have moved).
      refundStatus: refundStatus === "refunded" ? "refunded" : "manual_review",
      showRefundPath: refundStatus === "refunded",
      refundAmountCents: row.refund_amount_cents,
    },
  };
}

// =====================================================================
//                          Validation helpers
// =====================================================================

function validateSubmission(answers) {
  const errors = [];
  if (!answers || typeof answers !== "object") {
    return ["answers payload required"];
  }
  if (!REASON_CODES.has(answers.reason_code)) {
    errors.push("reason_code missing or invalid");
  }
  if (
    answers.reason_code === "other" &&
    (!answers.reason_other_text || String(answers.reason_other_text).trim().length < 2)
  ) {
    errors.push("reason_other_text required when reason_code='other'");
  }
  if (answers.consult_scores != null) {
    if (typeof answers.consult_scores !== "object") {
      errors.push("consult_scores must be an object");
    } else {
      for (const k of CONSULT_SCORE_KEYS) {
        const v = answers.consult_scores[k];
        // null is allowed (Section 2 may be hidden or skipped); strings rejected.
        if (v !== null && v !== undefined) {
          if (!Number.isInteger(v) || v < 1 || v > 5) {
            errors.push(`consult_scores.${k} must be an integer 1-5`);
          }
        }
      }
    }
  }
  if (
    answers.winback_opt_in != null &&
    typeof answers.winback_opt_in !== "boolean"
  ) {
    errors.push("winback_opt_in must be boolean");
  }
  if (
    answers.winback_earliest_month &&
    !/^\d{4}-\d{2}$/.test(answers.winback_earliest_month)
  ) {
    errors.push("winback_earliest_month must be YYYY-MM");
  }
  return errors;
}

// drop_off_stage → last_stage_before_lost (the analytic-friendly label)
function mapDropOffToLastStage(dropOff) {
  switch (dropOff) {
    case DROP_OFF_STAGES.PRE_CONSULT:
      return "Deposit Paid";
    case DROP_OFF_STAGES.CONSULT_SCHEDULED:
      return "Consult Scheduled";
    case DROP_OFF_STAGES.POST_CONSULT:
      return "Consult Completed";
    case DROP_OFF_STAGES.TATTOO_BOOKED:
      return "Tattoo Booked";
    default:
      return null;
  }
}

// reason_code (10 form options) → lost_reason (8 cause-only buckets, §6.6).
function mapReasonCodeToLostReason(reasonCode) {
  switch (reasonCode) {
    case "price":
      return "price_too_high";
    case "finances":
      return "financial_issue";
    case "found_other":
      return "chose_other_artist_or_shop";
    case "scheduling":
      return "scheduling_conflict";
    case "not_now":
      return "not_ready_for_tattoo";
    case "style_fit":
    case "design_confidence":
      return "style_or_design_mismatch";
    case "consult_expectations":
      return "underwhelming_experience";
    case "personal_medical":
      return "personal_or_medical";
    case "other":
      return "other";
    default:
      return null;
  }
}

module.exports = {
  generateRefundToken,
  consultDidHappen,
  deriveDropOffStage,
  showConsultQualityFor,
  locatePaidDeposit,
  createRefundRequest,
  getRefundRequestByToken,
  submitRefundRequest,
  // Phase 5 helpers — exported for direct tests + Phase 7 manual-refund reuse.
  notifyRefundManualReview,
  lookupOriginalDepositTxn,
  postRefundLedgerRow,
  mirrorRefundToInstantDb,
  postLostTransitionAndWinback,
  // Exported for tests + Phase 5/6 reuse:
  validateSubmission,
  mapDropOffToLastStage,
  mapReasonCodeToLostReason,
  DROP_OFF_STAGES,
  REASON_CODES,
  CONSULT_SCORE_KEYS,
};
