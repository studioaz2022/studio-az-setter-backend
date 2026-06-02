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
} = require("../clients/ghlClient");
const { getOpportunitiesByContact } = require("../clients/ghlOpportunityClient");

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

  // 1. Primary signal — Fireflies transcript in Supabase.
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
    // Fall through to GHL signals — don't fail the whole derivation.
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
  const url = `${REFUND_FORM_BASE_URL}/r/${token}`;
  const smsBody = isSpanish
    ? `Hola ${firstName}, lamentamos que no podamos seguir adelante. Por favor completa este formulario corto para procesar tu reembolso: ${url}`
    : `Hi ${firstName}, we're sorry it didn't work out. Please complete this short form to process your refund: ${url}`;

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
      url,
      reused: false,
      smsWarning: err.message,
    };
  }

  return { success: true, token, url, reused: false };
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
//                       submitRefundRequest (Phase 3 stub)
// =====================================================================

/**
 * Phase 3: persist the form answers ONLY. Money + Lost stay stubbed; Phase 5
 * wires them in. Returns success once the row is updated.
 *
 * Double-submit guard uses a compare-and-set update:
 *   UPDATE refund_requests SET status='completed', ... WHERE token=$1 AND status='pending'
 * If 0 rows changed, the token was already submitted/expired → 410.
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

  // 2. Read the row to derive analytics fields + idempotency check.
  const { data: row, error: readErr } = await supabase
    .from("refund_requests")
    .select(
      "id, status, drop_off_stage, refund_amount_cents, multi_or_missing_deposit, expires_at"
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
  // refund_type is set in Phase 5 once the refund actually fires. For now
  // we record the manual_review branch (which doesn't depend on the refund
  // outcome) so the form's success copy stays accurate.
  const refund_type = row.multi_or_missing_deposit ? null : null;

  // 4. CAS update — only takes effect if status is still 'pending'.
  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
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
      refund_type,
      submitted_ip: requestMeta.ip || null,
      submitted_user_agent: requestMeta.userAgent || null,
      submitted_at: now,
      status: "completed",
    })
    .eq("token", token)
    .eq("status", "pending")
    .select()
    .maybeSingle();

  if (updErr) {
    console.error(`[refundRequest] submit update error: ${updErr.message}`);
    return { success: false, error: "internal", httpStatus: 500 };
  }
  if (!updated) {
    // CAS lost: token went from pending → completed/expired between read and
    // update (concurrent submit, or the lazy-expire we missed). Re-read to
    // give the caller a precise error.
    return { success: false, error: "already_submitted", httpStatus: 410 };
  }

  // Phase 5 will run here:
  //   - If row.multi_or_missing_deposit → notifyRefundManualReview (no Square call).
  //   - Else → refundPayment + insert refund ledger row.
  //   - Either path → transitionToStage(COLD_NURTURE_LOST, { lostReason, refundType }).
  //   - Either path → seed winback tag.
  console.log(
    `[refundRequest] Submit received (Phase 3 stub) — token=${token.slice(0, 8)}… stage=${row.drop_off_stage} multi/missing=${row.multi_or_missing_deposit}`
  );

  return {
    success: true,
    data: {
      refundStatus: row.multi_or_missing_deposit ? "manual_review" : "pending",
      showRefundPath: !row.multi_or_missing_deposit,
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
  // Exported for tests + Phase 5/6 reuse:
  validateSubmission,
  mapDropOffToLastStage,
  mapReasonCodeToLostReason,
  DROP_OFF_STAGES,
  REASON_CODES,
  CONSULT_SCORE_KEYS,
};
