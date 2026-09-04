// firefliesArchive.js
// Durable, non-destructive storage for consultation transcripts.
//
// THE PROBLEM THIS SOLVES
// ----------------------
// Transcripts used to live in exactly one place: four GHL custom fields on the
// contact. Custom fields are per-contact, so a client's second consultation
// silently overwrote their first — Josh Bernia's 2026-08-25 call was destroyed
// by his 2026-08-26 one, and nothing recorded that it had happened.
//
// Meanwhile Fireflies storage is capped in MINUTES and was 100% full, so old
// meetings have to be deleted. Deleting the only copy of a client conversation
// is not an option, which makes durable storage the precondition for cleanup
// rather than a nice-to-have.
//
// THE SHAPE
// ---------
// Three destinations, each with a different job:
//
//   1. Supabase fireflies_transcripts — THE ARCHIVE. One row per meeting,
//      holding the full text. Never overwritten, independently addressable,
//      queryable. This is the copy that makes deleting from Fireflies safe.
//
//   2. GHL contact note — one per consultation, unlimited per contact, never
//      overwrites. This is what the front desk and artists actually read, and
//      it means a repeat client's history stays intact in the CRM.
//
//   3. GHL custom fields — MOST RECENT consult only. Deliberately still
//      overwritten: the iOS app, AI setter and pre-consult notes flow all read
//      these four field IDs expecting "the latest consult", and changing that
//      contract would break them. They are a cache over the archive now, not
//      the system of record.
//
// Failure of any one destination must not lose the others, so each is written
// independently and reported separately.

const { createClient } = require("@supabase/supabase-js");
const { ghl } = require("../clients/ghlSdk");
const { updateContact } = require("../clients/ghlClient");

const TAG = "[FirefliesArchive]";

// GHL custom field IDs — "most recent consult" cache. See note above.
const FIELD = {
  rawText: "Tj9WuXbE1hWtxfTgCMGM", // fireflies_transcript_text
  summary: "EU4U5jeDJxXHQ8Jh8gfT", // fireflies_chatgpt_summary
  transcriptId: "LUASmxIwwPBr3SsZEHd9", // fireflies_transcript_id
  processedAt: "HORoQH6waBo9xSabFbyM", // fireflies_processed_at
};

// GHL notes reject very large bodies. The full text always lands in Supabase;
// the note carries the summary plus a readable excerpt so the CRM stays useful
// without becoming the archive.
const NOTE_EXCERPT_LIMIT = 8000;

let supabase = null;
function db() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  supabase = createClient(url, key);
  return supabase;
}

/**
 * Render the per-consult GHL note body.
 * Summary first — that is what someone opening the contact actually wants.
 */
function buildNoteBody({ transcript, summaryText, clientName }) {
  const when = transcript.date
    ? new Date(transcript.date).toLocaleString("en-US", {
        timeZone: "America/Chicago",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "unknown date";

  const mins = transcript.duration ? `${Math.round(transcript.duration)} min` : "";
  const header = `🎙️ Consultation — ${when}${mins ? ` (${mins})` : ""}`;

  const parts = [header, ""];
  if (summaryText) parts.push(summaryText, "");

  const raw = transcript.__rawText || "";
  if (raw) {
    parts.push("─".repeat(40), "FULL TRANSCRIPT", "");
    if (raw.length > NOTE_EXCERPT_LIMIT) {
      parts.push(raw.slice(0, NOTE_EXCERPT_LIMIT));
      parts.push(
        "",
        `… truncated (${raw.length.toLocaleString()} chars total). ` +
          `Full text archived in Supabase fireflies_transcripts, transcript_id ${transcript.id}.`
      );
    } else {
      parts.push(raw);
    }
  }
  if (clientName) parts.push("", `Client: ${clientName}`);
  return parts.join("\n");
}

/**
 * Archive one consultation to all three destinations.
 *
 * Each destination is written independently — a GHL outage must not cost us
 * the Supabase archive, and a note failure must not block the custom fields.
 *
 * @param {object} p
 * @param {object} p.transcript        Fireflies transcript (id, title, date, duration)
 * @param {string} p.rawText           Formatted speaker-labeled transcript
 * @param {string} [p.summaryText]     Our own consultationSummarizer output
 * @param {object} [p.firefliesSummary] Fireflies' own AI summary object
 * @param {string} [p.contactId]       GHL contact, when matched
 * @param {string} [p.clientName]
 * @param {string} [p.status]          Supabase status value
 * @param {boolean} [p.updateFields]   Write the "latest consult" custom fields
 * @returns {Promise<{supabase: boolean, note: string|null, fields: boolean, errors: string[]}>}
 */
async function archiveConsultation({
  transcript,
  rawText,
  summaryText = "",
  firefliesSummary = null,
  contactId = null,
  clientName = null,
  status = "processed",
  updateFields = true,
}) {
  const errors = [];
  const result = { supabase: false, note: null, fields: false, errors };

  // ── 1. Supabase — the archive. Written first and on its own, because it is
  //       the copy that makes a later Fireflies delete safe.
  const sb = db();
  if (sb) {
    try {
      const { error } = await sb.from("fireflies_transcripts").upsert(
        {
          transcript_id: transcript.id,
          contact_id: contactId,
          meeting_title: transcript.title || null,
          meeting_date: transcript.date ? new Date(transcript.date).toISOString() : null,
          duration_minutes: transcript.duration ?? null,
          transcript_text: rawText || null,
          summary_text: summaryText || null,
          fireflies_summary: firefliesSummary,
          status,
          processed_at: new Date().toISOString(),
          archived_at: rawText ? new Date().toISOString() : null,
        },
        { onConflict: "transcript_id" }
      );
      if (error) throw new Error(error.message);
      result.supabase = true;
    } catch (err) {
      errors.push(`supabase: ${err.message}`);
      console.error(`${TAG} Supabase archive failed for ${transcript.id}:`, err.message);
    }
  } else {
    errors.push("supabase: not configured");
  }

  if (!contactId) return result;

  // ── 2. GHL note — one per consultation, never overwrites a previous one.
  try {
    const body = buildNoteBody({
      transcript: { ...transcript, __rawText: rawText },
      summaryText,
      clientName,
    });
    const noteResp = await ghl.contacts.createNote({ contactId }, { body });
    const noteId = noteResp?.note?.id || noteResp?.id || null;
    result.note = noteId;
    if (sb && noteId) {
      await sb
        .from("fireflies_transcripts")
        .update({ ghl_note_id: noteId })
        .eq("transcript_id", transcript.id);
    }
    console.log(`${TAG} Note added to contact ${contactId} for ${transcript.id}`);
  } catch (err) {
    errors.push(`note: ${err.message}`);
    console.error(`${TAG} Note creation failed for ${contactId}:`, err.message);
  }

  // ── 3. GHL custom fields — "most recent consult" cache for the iOS app and
  //       AI setter. Skipped on backfill of older meetings so a 6-month-old
  //       consult cannot displace a current one.
  if (updateFields) {
    try {
      await updateContact(contactId, {
        customField: {
          [FIELD.rawText]: rawText,
          [FIELD.summary]: summaryText,
          [FIELD.transcriptId]: transcript.id,
          [FIELD.processedAt]: new Date().toISOString(),
        },
      });
      result.fields = true;
    } catch (err) {
      errors.push(`fields: ${err.message}`);
      console.error(`${TAG} Custom field update failed for ${contactId}:`, err.message);
    }
  }

  return result;
}

/**
 * Is this transcript safely archived — i.e. do we hold the words ourselves?
 * The cleanup sweep gates every delete on this.
 */
async function isArchived(transcriptId) {
  const sb = db();
  if (!sb) return false;
  const { data } = await sb
    .from("fireflies_transcripts")
    .select("transcript_text")
    .eq("transcript_id", transcriptId)
    .maybeSingle();
  return Boolean(data && data.transcript_text);
}

module.exports = {
  archiveConsultation,
  isArchived,
  buildNoteBody,
  FIELD,
};
