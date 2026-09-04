// firefliesClient.js
// Fireflies.ai GraphQL API client for fetching and managing transcripts.
// Used as a backup transcription source when Google Meet/Gemini artifacts
// are unavailable (e.g., host joined from mobile). In practice it is the
// ONLY source — the Google Meet recording/Gemini path has never produced a
// single artifact (verified 2026-09-04 across all 32 consult contacts).
//
// ─────────────────────────────────────────────────────────────────────────
// ⚠️  HARD RATE LIMIT: 50 GRAPHQL REQUESTS PER DAY (Free/Pro plans)
// ─────────────────────────────────────────────────────────────────────────
// This is a DAILY cap on the whole account, not per-endpoint and not
// per-caller. Business/Enterprise get 60/min instead; we are not on those.
//
// Everything shares that one budget: the /fireflies/webhook transcript
// fetch, the reprocess-unmatched backfill, the cleanup deletes, and any
// ad-hoc diagnostics. Blowing it through one of them silently breaks the
// others for the rest of the UTC day.
//
// Over the cap, EVERY query returns:
//   "Too many requests. Please retry after <date> (UTC)"
// The quota resets at 00:00 UTC, not on a rolling window.
//
// Why this matters more than it looks: the webhook handler bails out and
// returns when getTranscript() throws, WITHOUT writing a row to
// fireflies_transcripts. A consultation burned by the rate limit leaves no
// trace anywhere — no GHL field, no Supabase row, no unmatched record. It
// just silently never existed.
//
// So before adding ANY new Fireflies call, budget it against 50/day. Never
// poll this API in a loop. (Learned the hard way on 2026-09-04: a deploy
// poll loop hitting a diagnostics endpoint consumed the day's entire quota.)
//
// ─────────────────────────────────────────────────────────────────────────
// PLAN-GATED FIELDS (confirmed against the live account, 2026-09-04)
// ─────────────────────────────────────────────────────────────────────────
// Requesting these on our plan fails with "You need to be subscribed to a
// paid plan to perform this action" — and because one unauthorized field
// fails the WHOLE query, never mix them into a query you need to succeed:
//   • audio_url    — BLOCKED (Pro+)
//   • video_url    — BLOCKED (Pro+)
//   • analytics    — believed Pro+ per docs; not confirmed
// Available to us: sentences, title, date, duration, summary, speakers.
//
// Storage is capped in MINUTES of stored recordings (400/seat, pooled),
// not by transcript count, and it does not reset monthly — it is a total
// cap. Deleting old transcripts is the only way to reclaim it on Free.

require("dotenv").config({ quiet: true });
const axios = require("axios");

const TAG = "[Fireflies]";
const FIREFLIES_ENDPOINT = "https://api.fireflies.ai/graphql";
const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY;

// ---------------------------------------------------------------------------
// Base GraphQL executor
// ---------------------------------------------------------------------------

/**
 * Execute a GraphQL query against Fireflies.
 *
 * ⚠️  Every call spends one of the account's 50 requests per DAY. See the
 * file header before adding callers. Over the cap this throws
 * "Fireflies GraphQL error: Too many requests. Please retry after ...".
 */
async function firefliesQuery(query, variables = {}) {
  if (!FIREFLIES_API_KEY) {
    throw new Error("FIREFLIES_API_KEY not set");
  }

  const resp = await axios.post(
    FIREFLIES_ENDPOINT,
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FIREFLIES_API_KEY}`,
      },
    }
  );

  if (resp.data.errors) {
    const msg = resp.data.errors.map((e) => e.message).join("; ");
    throw new Error(`Fireflies GraphQL error: ${msg}`);
  }

  return resp.data.data;
}

// ---------------------------------------------------------------------------
// getTranscript
// ---------------------------------------------------------------------------

/**
 * Fetch a single transcript by ID.
 * @param {string} id - Fireflies transcript ID (same as webhook meetingId)
 * @returns {Promise<{id, title, date, sentences: [{text, speaker_name, start_time, end_time}]}>}
 */
async function getTranscript(id) {
  const query = `
    query Transcript($id: String!) {
      transcript(id: $id) {
        id
        title
        date
        duration
        sentences {
          text
          speaker_name
          start_time
          end_time
        }
      }
    }
  `;

  const data = await firefliesQuery(query, { id });
  return data.transcript;
}

// ---------------------------------------------------------------------------
// getTranscriptSummary
// ---------------------------------------------------------------------------

/**
 * Fetch Fireflies' own AI summary for a transcript.
 *
 * Deliberately a SEPARATE request from getTranscript rather than extra fields
 * on it. A single failing field fails an entire GraphQL query, and losing the
 * sentences — the only thing we cannot regenerate — to a summary-shape change
 * or a plan gate would be the expensive failure. The summary is a nice-to-have
 * archived because it is free to us today and destroyed on delete; the words
 * are the asset. Costs one extra request/day against the 50/day cap (see
 * header), which at ~2 consults/day is affordable.
 *
 * Never throws — returns null so callers can archive without it.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function getTranscriptSummary(id) {
  const query = `
    query TranscriptSummary($id: String!) {
      transcript(id: $id) {
        id
        summary {
          overview
          action_items
          keywords
          outline
          bullet_gist
          short_summary
        }
      }
    }
  `;

  try {
    const data = await firefliesQuery(query, { id });
    return data?.transcript?.summary || null;
  } catch (err) {
    console.warn(`${TAG} Summary fetch failed for ${id} (non-fatal): ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// listTranscripts
// ---------------------------------------------------------------------------

/**
 * List all transcripts (for polling/debugging).
 * @returns {Promise<Array<{id, title, date}>>}
 */
async function listTranscripts() {
  const query = `
    {
      transcripts {
        id
        title
        date
      }
    }
  `;

  const data = await firefliesQuery(query);
  return data.transcripts || [];
}

// ---------------------------------------------------------------------------
// deleteTranscript
// ---------------------------------------------------------------------------

/**
 * Delete a single transcript by ID.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function deleteTranscript(id) {
  const query = `
    mutation DeleteTranscript($id: String!) {
      deleteTranscript(id: $id) {
        id
      }
    }
  `;

  await firefliesQuery(query, { id });
  console.log(`${TAG} Deleted transcript ${id}`);
  return true;
}

// ---------------------------------------------------------------------------
// batchDeleteTranscripts
// ---------------------------------------------------------------------------

/**
 * Delete multiple transcripts using GraphQL aliased mutations.
 * Up to 10 per request to stay within rate limits.
 * @param {string[]} ids
 * @returns {Promise<number>} Number of successfully deleted transcripts
 */
async function batchDeleteTranscripts(ids) {
  if (!ids || ids.length === 0) return 0;

  let totalDeleted = 0;

  // Process in chunks of 10. Each chunk is ONE aliased GraphQL request, so
  // it costs 1 against the 50/day account cap (see header) — the 60s sleep
  // below is for the separate 10-deletes-per-minute limit, not the daily one.
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);

    // Build aliased mutation
    const mutations = chunk
      .map((id, idx) => `d${idx}: deleteTranscript(id: "${id}") { id }`)
      .join("\n    ");

    const query = `mutation BatchDelete {\n    ${mutations}\n  }`;

    try {
      await firefliesQuery(query);
      totalDeleted += chunk.length;
      console.log(
        `${TAG} Batch deleted ${chunk.length} transcripts (${totalDeleted}/${ids.length})`
      );
    } catch (err) {
      console.error(
        `${TAG} Batch delete error (chunk starting at ${i}):`,
        err.message
      );
    }

    // Respect rate limit: 10 deletes/minute
    if (i + 10 < ids.length) {
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
  }

  return totalDeleted;
}

// ---------------------------------------------------------------------------
// formatTranscriptText
// ---------------------------------------------------------------------------

/**
 * Format raw Fireflies sentences into readable speaker-labeled dialogue.
 * @param {Array<{text, speaker_name, start_time, end_time}>} sentences
 * @returns {string} Formatted transcript text
 */
function formatTranscriptText(sentences) {
  if (!sentences || sentences.length === 0) return "";

  return sentences
    .map((s) => {
      const ts = formatTimestamp(s.start_time);
      const speaker = s.speaker_name || "Unknown";
      return `${speaker} (${ts}): ${s.text}`;
    })
    .join("\n");
}

/**
 * Convert seconds to HH:MM:SS format
 */
function formatTimestamp(seconds) {
  const totalSec = Math.floor(seconds || 0);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

module.exports = {
  firefliesQuery,
  getTranscript,
  getTranscriptSummary,
  listTranscripts,
  deleteTranscript,
  batchDeleteTranscripts,
  formatTranscriptText,
};
