// googleMeetArtifacts.js
// Fetches post-meeting artifacts (recordings, transcripts, smart notes/AI summaries)
// from the Google Meet REST API and Google Drive / Docs APIs.
// Reuses OAuth credentials from googleMeet.js.

const axios = require("axios");
const { getAccessToken } = require("./googleMeet");

const TAG = "[MeetArtifacts]";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the meeting code from a Google Meet URL.
 * Handles formats like:
 *   https://meet.google.com/abc-defg-hij
 *   https://meet.google.com/abc-defg-hij?authuser=0
 *   https://meet.google.com/abc-defg-hij/
 *   meet.google.com/abc-defg-hij
 *
 * @param {string} meetUrl - The full Google Meet URL
 * @returns {string} The meeting code (e.g. "abc-defg-hij")
 */
function extractMeetingCode(meetUrl) {
  if (!meetUrl || typeof meetUrl !== "string") {
    throw new Error(`${TAG} Invalid meetUrl: ${meetUrl}`);
  }

  // Strip protocol and www prefix if present, then strip meet.google.com host
  const cleaned = meetUrl
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^meet\.google\.com\//, "");

  // The meeting code is the first path segment; strip query params, hash fragments, and trailing slashes
  const code = cleaned.split("/")[0].split("?")[0].split("#")[0].trim();

  if (!code) {
    throw new Error(`${TAG} Could not extract meeting code from URL: ${meetUrl}`);
  }

  return code;
}

/**
 * Build an authorized axios config with the current access token.
 * @returns {Promise<object>}
 */
async function authHeaders() {
  const token = await getAccessToken();
  return { headers: { Authorization: `Bearer ${token}` } };
}

// ---------------------------------------------------------------------------
// 1. getConferenceRecord(meetUrl)
// ---------------------------------------------------------------------------

/**
 * Look up the conference record for a given Google Meet URL.
 *
 * Steps:
 *   1. Extract the meeting code from the URL.
 *   2. Resolve the meeting code to a Meet "space" via the Meet REST API.
 *   3. List conference records filtered by that space and return the most recent one.
 *
 * @param {string} meetUrl - Full Google Meet URL
 * @returns {Promise<object|null>} The most recent conferenceRecord object, or null
 */
async function getConferenceRecord(meetUrl) {
  const meetingCode = extractMeetingCode(meetUrl);
  console.log(`${TAG} Looking up space for meeting code: ${meetingCode}`);

  const config = await authHeaders();

  // Step 1 – Resolve meeting code to a space
  let spaceName;
  try {
    const spaceResp = await axios.get(
      `https://meet.googleapis.com/v2/spaces/${meetingCode}`,
      config
    );
    spaceName = spaceResp.data?.name; // e.g. "spaces/abc123"
    console.log(`${TAG} Resolved space: ${spaceName}`);
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      console.log(`${TAG} Space not found for meeting code ${meetingCode}`);
      return null;
    }
    if (status === 403) {
      console.log(`${TAG} No permission to access space for ${meetingCode}`);
      return null;
    }
    throw err;
  }

  if (!spaceName) {
    console.log(`${TAG} Space lookup returned no name`);
    return null;
  }

  // Step 2 – List conference records filtered by this space
  try {
    const recordsResp = await axios.get(
      "https://meet.googleapis.com/v2/conferenceRecords",
      {
        ...config,
        params: {
          filter: `space.name = "${spaceName}"`,
        },
      }
    );

    const records = recordsResp.data?.conferenceRecords || [];
    if (records.length === 0) {
      console.log(`${TAG} No conference records found for space ${spaceName}`);
      return null;
    }

    // Return the most recent record (last in the list, or sort by startTime descending)
    const sorted = records.sort(
      (a, b) => new Date(b.startTime) - new Date(a.startTime)
    );
    const latest = sorted[0];
    console.log(`${TAG} Found conference record: ${latest.name}`);
    return latest;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 403) {
      console.log(
        `${TAG} Could not list conference records (${status}) for space ${spaceName}`
      );
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 2. getRecordingLinks(conferenceRecordName)
// ---------------------------------------------------------------------------

/**
 * Fetch recording links for a conference record.
 *
 * @param {string} conferenceRecordName - e.g. "conferenceRecords/abc123"
 * @returns {Promise<Array<{exportUri: string, fileId: string}>>}
 */
async function getRecordingLinks(conferenceRecordName) {
  console.log(`${TAG} Fetching recordings for ${conferenceRecordName}`);
  const config = await authHeaders();

  try {
    const resp = await axios.get(
      `https://meet.googleapis.com/v2/${conferenceRecordName}/recordings`,
      config
    );

    const recordings = (resp.data?.recordings || []).filter(
      (r) => r.state === "FILE_GENERATED"
    );

    const links = recordings.map((r) => ({
      exportUri: r.driveDestination?.exportUri || null,
      fileId: r.driveDestination?.file || null,
    }));

    console.log(
      `${TAG} Found ${links.length} recording(s) with FILE_GENERATED state`
    );
    return links;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      console.log(`${TAG} No recordings endpoint found (404) — may not be ready yet`);
      return [];
    }
    if (status === 403) {
      console.log(`${TAG} No permission to access recordings (403)`);
      return [];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 3. getTranscriptLinks(conferenceRecordName)
// ---------------------------------------------------------------------------

/**
 * Fetch transcript links for a conference record.
 *
 * @param {string} conferenceRecordName - e.g. "conferenceRecords/abc123"
 * @returns {Promise<Array<{exportUri: string, documentId: string}>>}
 */
async function getTranscriptLinks(conferenceRecordName) {
  console.log(`${TAG} Fetching transcripts for ${conferenceRecordName}`);
  const config = await authHeaders();

  try {
    const resp = await axios.get(
      `https://meet.googleapis.com/v2/${conferenceRecordName}/transcripts`,
      config
    );

    const transcripts = (resp.data?.transcripts || []).filter(
      (t) => t.state === "FILE_GENERATED"
    );

    const links = transcripts.map((t) => ({
      exportUri: t.docsDestination?.exportUri || null,
      documentId: t.docsDestination?.document || null,
    }));

    console.log(
      `${TAG} Found ${links.length} transcript(s) with FILE_GENERATED state`
    );
    return links;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      console.log(`${TAG} No transcripts endpoint found (404) — may not be ready yet`);
      return [];
    }
    if (status === 403) {
      console.log(`${TAG} No permission to access transcripts (403)`);
      return [];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4. getSmartNotes(conferenceRecordName)
// ---------------------------------------------------------------------------

/**
 * Fetch smart notes (AI-generated meeting summaries) for a conference record.
 * Uses the v2beta endpoint — this is a beta feature and may not be available
 * for all accounts or meetings.
 *
 * @param {string} conferenceRecordName - e.g. "conferenceRecords/abc123"
 * @returns {Promise<Array<{exportUri: string, documentId: string}>>}
 */
async function getSmartNotes(conferenceRecordName) {
  console.log(`${TAG} Fetching smart notes (beta) for ${conferenceRecordName}`);
  const config = await authHeaders();

  try {
    const resp = await axios.get(
      `https://meet.googleapis.com/v2beta/${conferenceRecordName}/smartNotes`,
      config
    );

    const notes = resp.data?.smartNotes || [];

    const links = notes.map((n) => ({
      exportUri: n.docsDestination?.exportUri || null,
      documentId: n.docsDestination?.document || null,
    }));

    console.log(`${TAG} Found ${links.length} smart note(s)`);
    return links;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      console.log(
        `${TAG} Smart notes not available (404) — beta endpoint may not be enabled`
      );
      return [];
    }
    if (status === 403) {
      console.log(`${TAG} No permission to access smart notes (403)`);
      return [];
    }
    // Any other error from the beta endpoint is treated as "not available"
    console.log(
      `${TAG} Smart notes request failed (${status || err.message}) — treating as unavailable`
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// 5. getDocContent(documentId)
// ---------------------------------------------------------------------------

/**
 * Fetch the plain-text content of a Google Doc via the Drive export API.
 * Exports the document as plain text — works with drive.readonly scope.
 *
 * @param {string} documentId - The Google Docs document ID
 * @returns {Promise<string|null>} The extracted text, or null on failure
 */
async function getDocContent(documentId) {
  if (!documentId) return null;

  console.log(`${TAG} Fetching document content for doc ${documentId}`);
  const config = await authHeaders();

  try {
    const resp = await axios.get(
      `https://www.googleapis.com/drive/v3/files/${documentId}/export`,
      {
        ...config,
        params: { mimeType: "text/plain" },
        responseType: "text",
      }
    );

    const text = (resp.data || "").trim();
    console.log(
      `${TAG} Extracted ${text.length} characters from document ${documentId}`
    );
    return text || null;
  } catch (err) {
    const status = err.response?.status;
    console.log(
      `${TAG} Failed to fetch document ${documentId} (${status || err.message})`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// 6. searchDriveForMeetNotes(meetingCode)
// ---------------------------------------------------------------------------

/**
 * Fallback: search Google Drive for Gemini-generated meeting notes.
 *
 * Gemini saves notes as Google Docs named like:
 *   "<Calendar Event Title> - <date> - Notes by Gemini"
 * e.g. "Online Consultation - Leonel Chavez - 2026/02/15 15:56 CST - Notes by Gemini"
 *
 * We search by multiple strategies in priority order:
 *   1. "Notes by Gemini" docs created around the meeting time
 *   2. Meeting code in the filename (rare but possible)
 *
 * @param {string} meetingCode - The meeting code (e.g. "rio-kgds-pqn")
 * @param {object} [options]
 * @param {string} [options.meetingDate] - ISO date of the meeting for narrowing results
 * @returns {Promise<{docUrl: string|null, docId: string|null, docText: string|null}>}
 */
async function searchDriveForMeetNotes(meetingCode, options = {}) {
  console.log(`${TAG} Searching Drive for Gemini meeting notes`);

  const TIME_WINDOW_MS = 2 * 60 * 60 * 1000; // ±2 hours

  try {
    const config = await authHeaders();

    // Build search queries in priority order
    const searches = [];

    // Strategy 1: Search for "Notes by Gemini" docs (most reliable)
    searches.push(
      `mimeType='application/vnd.google-apps.document' and name contains 'Notes by Gemini' and trashed=false`
    );

    // Strategy 2: Search by meeting code in filename
    searches.push(
      `mimeType='application/vnd.google-apps.document' and name contains '${meetingCode}' and trashed=false`
    );

    for (const query of searches) {
      const resp = await axios.get("https://www.googleapis.com/drive/v3/files", {
        ...config,
        params: {
          q: query,
          fields: "files(id,name,createdTime,webViewLink)",
          orderBy: "createdTime desc",
          pageSize: 10,
        },
      });

      const files = resp.data?.files || [];
      if (files.length > 0) {
        let doc = null;

        if (options.meetingDate) {
          const meetTime = new Date(options.meetingDate).getTime();
          // Only accept docs created within ±2 hours of the meeting start
          const matched = files.find((f) => {
            const docTime = new Date(f.createdTime).getTime();
            return Math.abs(docTime - meetTime) <= TIME_WINDOW_MS;
          });
          if (matched) {
            doc = matched;
          } else {
            console.log(`${TAG} Found ${files.length} Gemini doc(s) but none within ±2hr of meeting time — skipping`);
            continue;
          }
        } else {
          doc = files[0];
        }

        if (doc) {
          console.log(`${TAG} Found Gemini notes: "${doc.name}" (${doc.id})`);

          const docText = await getDocContent(doc.id);
          return {
            docUrl: doc.webViewLink || `https://docs.google.com/document/d/${doc.id}/edit`,
            docId: doc.id,
            docText,
          };
        }
      }
    }

    console.log(`${TAG} No Gemini notes found in Drive`);
    return { docUrl: null, docId: null, docText: null };
  } catch (err) {
    const status = err.response?.status;
    console.log(`${TAG} Drive search failed (${status || err.message})`);
    return { docUrl: null, docId: null, docText: null };
  }
}

// ---------------------------------------------------------------------------
// 7. fetchAllArtifacts(meetUrl)
// ---------------------------------------------------------------------------

/**
 * Orchestrator: fetch all available post-meeting artifacts for a given Meet URL.
 *
 * Returns an object with the first available link for each artifact type.
 * Fields are null when the artifact is not (yet) available.
 *
 * @param {string} meetUrl - Full Google Meet URL
 * @returns {Promise<{
 *   recordingUrl: string|null,
 *   transcriptUrl: string|null,
 *   smartNotesUrl: string|null,
 *   smartNotesText: string|null
 * }>}
 */
async function fetchAllArtifacts(meetUrl) {
  console.log(`${TAG} === Fetching all artifacts for ${meetUrl} ===`);

  const result = {
    recordingUrl: null,
    transcriptUrl: null,
    smartNotesUrl: null,
    smartNotesText: null,
  };

  // Step 1 – Resolve the conference record
  let conferenceRecord;
  try {
    conferenceRecord = await getConferenceRecord(meetUrl);
  } catch (err) {
    console.log(`${TAG} Error resolving conference record: ${err.message}`);
    return result;
  }

  if (!conferenceRecord) {
    console.log(`${TAG} No conference record found — returning empty artifacts`);
    return result;
  }

  const crName = conferenceRecord.name; // e.g. "conferenceRecords/abc123"

  // Step 2 – Fetch recordings, transcripts, and smart notes in parallel
  const [recordings, transcripts, smartNotes] = await Promise.all([
    getRecordingLinks(crName).catch((err) => {
      console.log(`${TAG} Error fetching recordings: ${err.message}`);
      return [];
    }),
    getTranscriptLinks(crName).catch((err) => {
      console.log(`${TAG} Error fetching transcripts: ${err.message}`);
      return [];
    }),
    getSmartNotes(crName).catch((err) => {
      console.log(`${TAG} Error fetching smart notes: ${err.message}`);
      return [];
    }),
  ]);

  // Step 3 – Populate result with the first available link from each category

  if (recordings.length > 0) {
    result.recordingUrl = recordings[0].exportUri;
    console.log(`${TAG} Recording URL: ${result.recordingUrl}`);
  } else {
    console.log(`${TAG} No recordings available yet`);
  }

  if (transcripts.length > 0) {
    result.transcriptUrl = transcripts[0].exportUri;
    console.log(`${TAG} Transcript URL: ${result.transcriptUrl}`);
  } else {
    console.log(`${TAG} No transcripts available yet`);
  }

  if (smartNotes.length > 0) {
    result.smartNotesUrl = smartNotes[0].exportUri;
    console.log(`${TAG} Smart Notes URL: ${result.smartNotesUrl}`);

    // Step 4 – Try to pull the actual text content of the smart notes doc
    if (smartNotes[0].documentId) {
      try {
        result.smartNotesText = await getDocContent(smartNotes[0].documentId);
      } catch (err) {
        console.log(`${TAG} Error fetching smart notes text: ${err.message}`);
      }
    }
  } else {
    console.log(`${TAG} No smart notes via API — trying Drive search fallback`);

    // Fallback: search Google Drive for Gemini meeting notes docs
    try {
      const meetingCode = extractMeetingCode(meetUrl);
      const driveResult = await searchDriveForMeetNotes(meetingCode, {
        meetingDate: conferenceRecord.startTime,
      });
      if (driveResult.docUrl) {
        result.smartNotesUrl = driveResult.docUrl;
        result.smartNotesText = driveResult.docText;
        console.log(`${TAG} Found notes via Drive fallback: ${driveResult.docUrl}`);
      } else {
        console.log(`${TAG} No smart notes found via Drive fallback either`);
      }
    } catch (err) {
      console.log(`${TAG} Drive fallback error: ${err.message}`);
    }
  }

  console.log(`${TAG} === Artifact fetch complete ===`);
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  extractMeetingCode,
  getConferenceRecord,
  getRecordingLinks,
  getTranscriptLinks,
  getSmartNotes,
  getDocContent,
  searchDriveForMeetNotes,
  fetchAllArtifacts,
};
