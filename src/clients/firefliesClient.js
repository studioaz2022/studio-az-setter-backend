// firefliesClient.js
// Fireflies.ai GraphQL API client for fetching and managing transcripts.
// Used as a backup transcription source when Google Meet/Gemini artifacts
// are unavailable (e.g., host joined from mobile).

require("dotenv").config();
const axios = require("axios");

const TAG = "[Fireflies]";
const FIREFLIES_ENDPOINT = "https://api.fireflies.ai/graphql";
const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY;

// ---------------------------------------------------------------------------
// Base GraphQL executor
// ---------------------------------------------------------------------------

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

  // Process in chunks of 10
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
  listTranscripts,
  deleteTranscript,
  batchDeleteTranscripts,
  formatTranscriptText,
};
