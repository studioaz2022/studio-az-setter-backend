// googleMeet.js
// Lightweight Google Calendar client to generate Google Meet links

require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");

const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const MEET_CALENDAR_ID =
  process.env.MEET_CALENDAR_ID ||
  process.env.GOOGLE_CALENDAR_ID ||
  "primary";
const MEET_ORGANIZER_EMAIL = process.env.MEET_ORGANIZER_EMAIL;
const MEET_TZ = process.env.MEET_TZ || "America/Chicago";

function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(12).toString("hex");
}

async function getAccessToken() {
  if (
    !GOOGLE_OAUTH_CLIENT_ID ||
    !GOOGLE_OAUTH_CLIENT_SECRET ||
    !GOOGLE_REFRESH_TOKEN
  ) {
    throw new Error(
      "Missing Google OAuth credentials (client id/secret/refresh token)"
    );
  }

  const tokenUrl = "https://oauth2.googleapis.com/token";
  const payload = {
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  };

  const resp = await axios.post(tokenUrl, payload, {
    headers: { "Content-Type": "application/json" },
  });

  const accessToken = resp.data?.access_token;
  if (!accessToken) {
    throw new Error("Google OAuth token exchange did not return access_token");
  }

  return accessToken;
}

/**
 * Create a Google Calendar event with Meet link
 * @param {object} params
 * @param {string} params.summary
 * @param {string} params.description
 * @param {string} params.startISO
 * @param {string} params.endISO
 * @param {string[]} [params.attendees] - array of attendee emails
 * @returns {Promise<{meetUrl: string|null, htmlLink: string|null, raw: object}>}
 */
async function createGoogleMeet({
  summary,
  description,
  startISO,
  endISO,
  attendees = [],
}) {
  const accessToken = await getAccessToken();

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    MEET_CALENDAR_ID
  )}/events?conferenceDataVersion=1&sendUpdates=all`;

  const attendeeObjects = (attendees || [])
    .filter(Boolean)
    .map((email) => ({ email }));

  const eventBody = {
    summary: summary || "Consultation",
    description: description || "",
    start: { dateTime: startISO, timeZone: MEET_TZ },
    end: { dateTime: endISO, timeZone: MEET_TZ },
    attendees: attendeeObjects,
    conferenceData: {
      createRequest: {
        requestId: randomId(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  if (MEET_ORGANIZER_EMAIL) {
    eventBody.organizer = { email: MEET_ORGANIZER_EMAIL };
  }

  const resp = await axios.post(url, eventBody, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = resp.data || {};
  const meetUrl =
    data.hangoutLink ||
    data.conferenceData?.entryPoints?.find((p) => p.uri)?.uri ||
    null;

  return {
    meetUrl,
    htmlLink: data.htmlLink || null,
    raw: data,
  };
}

module.exports = {
  createGoogleMeet,
};
