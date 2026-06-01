// botVersion.js — AI setter brain version resolver (Phase 0 feature flag)
//
// Resolves which conversational controller handles a contact: the legacy "v1"
// brain (src/ai/controller.js) or the "v2" rewrite (src/ai/v2/controller.js).
//
// Resolution order (first match wins):
//   1. Per-contact override — `ai_bot_version` custom field ("v1" | "v2")
//   2. Global default — AI_BOT_VERSION env var ("v1" | "v2")
//   3. Hard default — "v1"
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

/**
 * Resolve the bot version for a specific contact. A valid per-contact
 * `ai_bot_version` custom field overrides the global default.
 * @param {object} [contact] GHL contact (may carry customField/customFields)
 * @returns {"v1"|"v2"}
 */
function resolveBotVersion(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  const override = normalizeVersion(cf[SYSTEM_FIELDS.AI_BOT_VERSION]);
  return override || getGlobalBotVersion();
}

module.exports = {
  resolveBotVersion,
  getGlobalBotVersion,
  normalizeVersion,
  VALID_VERSIONS,
  DEFAULT_VERSION,
};
