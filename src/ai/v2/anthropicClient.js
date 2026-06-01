// anthropicClient.js — Anthropic SDK wrapper for the v2 AI setter (Phase 1).
//
// Thin wrapper around the Messages API with prompt caching. The conversational brain
// (Haiku 4.5 by default, Sonnet 4.6 on escalation in Phase 3) lives behind this.
//
// Prompt caching: the system prompt (and later the objection principles) are passed as
// a cached block (cache_control: ephemeral). On Anthropic, a cache hit drops input cost
// ~90% and the cache survives ~5 min — so back-to-back turns in a live conversation
// reuse it. We mark the LAST system block as the cache breakpoint.
//
// The client is constructed lazily (first call), reading ANTHROPIC_API_KEY at call time.
// This matters locally: the dev shell exports an empty ANTHROPIC_API_KEY that shadows
// .env, and test scripts fix it with dotenv override BEFORE the first call. On Render the
// key is a real env var, so lazy vs eager makes no difference there.

require("dotenv").config({ quiet: true });
const Anthropic = require("@anthropic-ai/sdk");

// Model IDs (from the plan's model strategy).
const MODELS = {
  HAIKU: "claude-haiku-4-5-20251001", // default conversational model
  SONNET: "claude-sonnet-4-6", // escalation for objections / stuck conversations (Phase 3)
};

const DEFAULT_MAX_TOKENS = 1024;

let _client = null;
/** Lazily build (and cache) the SDK client, reading the key at call time. */
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  // SDK exports the class as the default/`Anthropic` export depending on interop.
  const Ctor = Anthropic.Anthropic || Anthropic;
  _client = new Ctor({ apiKey });
  return _client;
}

/**
 * Normalize a system prompt into text blocks, honoring explicit cache flags.
 * Accepts a string, or an array whose items are strings or { text, cache?:boolean }.
 * A block with cache:true gets a cache_control breakpoint — Anthropic caches the prefix
 * up to and including it, so put the STATIC prompt first with cache:true and any DYNAMIC
 * per-contact context after it (uncached). If no block sets cache, the last block is
 * cached by default (sensible for a single static string).
 * @param {string|Array} system
 * @returns {Array<{type:"text", text:string, cache_control?:object}>}
 */
function buildCachedSystem(system) {
  const blocks = (Array.isArray(system) ? system : [system])
    .map((b) => (typeof b === "string" ? { text: b } : b))
    .filter((b) => b && typeof b.text === "string" && b.text.length)
    .map((b) => {
      const blk = { type: "text", text: b.text };
      if (b.cache) blk.cache_control = { type: "ephemeral" };
      return blk;
    });
  if (blocks.length && !blocks.some((b) => b.cache_control)) {
    blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  }
  return blocks;
}

/**
 * Generate a reply from the conversational model.
 *
 * @param {object} args
 * @param {string|Array} args.system system prompt (string or text blocks); cached
 * @param {Array<{role:"user"|"assistant", content:string|Array}>} args.messages turn history
 * @param {string} [args.model] model id (defaults to Haiku 4.5)
 * @param {number} [args.maxTokens]
 * @param {number} [args.temperature]
 * @returns {Promise<{text:string, usage:object, model:string, stopReason:string, raw:object}>}
 */
async function generateReply({ system, messages, model = MODELS.HAIKU, maxTokens = DEFAULT_MAX_TOKENS, temperature = 0.7 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("generateReply requires a non-empty messages array");
  }
  const client = getClient();
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system: buildCachedSystem(system),
    messages,
  });

  // Concatenate text blocks from the response.
  const text = (resp.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return {
    text,
    usage: resp.usage || {},
    model: resp.model || model,
    stopReason: resp.stop_reason || null,
    raw: resp,
  };
}

module.exports = { generateReply, getClient, buildCachedSystem, MODELS, DEFAULT_MAX_TOKENS };
