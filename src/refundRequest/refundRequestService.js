// refundRequestService.js
// Service for the Refund Request Form flow — Supabase storage, deposit lookup,
// auto-refund, GHL Lost transition, win-back tagging.
//
// Mirrors src/consentForm/consentFormService.js conventions (token-gated
// public form, Supabase as authoritative store, GHL writes on submit).
//
// Phase 1 scope (REFUND_REQUEST_FORM_PLAN.md §8): token generator only. The
// lifecycle functions (createRefundRequest / getRefundRequestByToken /
// submitRefundRequest) land in Phase 3 after the table + the Square refund
// primitive are proven.

const crypto = require("crypto");

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

module.exports = {
  generateRefundToken,
};
