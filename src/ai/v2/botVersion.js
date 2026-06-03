// botVersion.js — AI setter brain version resolver (Phase 0 feature flag)
//
// Resolves which conversational controller handles a contact: the legacy "v1"
// brain (src/ai/controller.js) or the "v2" rewrite (src/ai/v2/controller.js).
//
// Resolution order (first match wins):
//   0. Test-phone allowlist — AI_BOT_V2_PHONES (comma list) forces "v2" for those numbers
//   1. Per-contact override — `ai_bot_version` custom field ("v1" | "v2")
//   2. Global default — AI_BOT_VERSION env var ("v1" | "v2")
//   3. Hard default — "v1"
//
// The phone allowlist exists so a specific test number routes to v2 from the VERY FIRST
// touch (incl. a brand-new contact created by the consultation form, which can't carry the
// per-contact field yet) without flipping anyone else. Matching is format-agnostic: both
// sides are reduced to their last 10 digits, so "+16123827435", "(612) 382-7435",
// "16123827435", "6123827435" all match the same allowlist entry.
//
// This is intentionally dormant during Phase 0: the global default is "v1" and
// no contact carries the override, so v2 is never selected until we wire the
// webhook branch in Phase 1. Reads the override defensively, so it works whether
// or not the `ai_bot_version` GHL custom field has been created yet.

const { SYSTEM_FIELDS } = require("../../config/constants");

const VALID_VERSIONS = ["v1", "v2"];
const DEFAULT_VERSION = "v1";

/**
 * Normalize an arbitrary value to a valid bot version, or null if unrecognized.
 * @param {*} value
 * @returns {"v1"|"v2"|null}
 */
function normalizeVersion(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return VALID_VERSIONS.includes(v) ? v : null;
}

/**
 * The global default version from the AI_BOT_VERSION env var (falls back to "v1").
 * @returns {"v1"|"v2"}
 */
function getGlobalBotVersion() {
  return normalizeVersion(process.env.AI_BOT_VERSION) || DEFAULT_VERSION;
}

/** Reduce any phone string to its last 10 digits (US), or "" if fewer than 10. */
function normalizePhone(p) {
  const digits = String(p || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

/** Parse AI_BOT_V2_PHONES into a Set of normalized (last-10-digit) numbers. */
function getTestPhones() {
  return new Set(
    String(process.env.AI_BOT_V2_PHONES || "")
      .split(",")
      .map(normalizePhone)
      .filter(Boolean)
  );
}

/** True if any of the contact's phone fields matches the test-phone allowlist. */
function isAllowlistedTestPhone(contact) {
  const allow = getTestPhones();
  if (!allow.size) return false;
  const candidates = [
    contact?.phone,
    contact?.phoneNumber,
    contact?.contact?.phone,
  ].map(normalizePhone);
  return candidates.some((c) => c && allow.has(c));
}

/**
 * Resolve the bot version for a specific contact.
 * Test-phone allowlist wins, then per-contact `ai_bot_version`, then the global default.
 * @param {object} [contact] GHL contact (may carry customField/customFields + phone)
 * @returns {"v1"|"v2"}
 */
function resolveBotVersion(contact) {
  if (isAllowlistedTestPhone(contact)) return "v2";
  const cf = contact?.customField || contact?.customFields || {};
  const override = normalizeVersion(cf[SYSTEM_FIELDS.AI_BOT_VERSION]);
  return override || getGlobalBotVersion();
}

module.exports = {
  resolveBotVersion,
  getGlobalBotVersion,
  normalizeVersion,
  normalizePhone,
  isAllowlistedTestPhone,
  VALID_VERSIONS,
  DEFAULT_VERSION,
};
