// workspaceEvents.js
// Google Workspace Events API client for Meet artifact push notifications.
// Creates per-space subscriptions so Google pushes a Pub/Sub notification
// when recordings or transcripts become available after a consultation.

const axios = require("axios");
const { getAccessToken } = require("./googleMeet");
const { supabase } = require("./supabaseClient");
const { extractMeetingCode } = require("./googleMeetArtifacts");

const TAG = "[WorkspaceEvents]";

const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
const PUBSUB_TOPIC = GOOGLE_CLOUD_PROJECT_ID
  ? `projects/${GOOGLE_CLOUD_PROJECT_ID}/topics/meet-artifact-events`
  : null;

// Event types to subscribe to
const MEET_EVENT_TYPES = [
  "google.workspace.meet.recording.v2.fileGenerated",
  "google.workspace.meet.transcript.v2.fileGenerated",
];

// 24 hours — maximum TTL for Workspace Events subscriptions
const SUBSCRIPTION_TTL_SECONDS = 86400;

// ---------------------------------------------------------------------------
// subscribeToMeetSpace
// ---------------------------------------------------------------------------

/**
 * Create a Workspace Events subscription for a Meet space.
 * Called right after creating a Google Meet link in bookingController.
 *
 * Non-blocking: returns null on any error so it never breaks appointment creation.
 *
 * @param {string} meetUrl  - Full Google Meet URL
 * @param {string} contactId - GHL contact ID
 * @returns {Promise<{subscriptionName: string, spaceName: string}|null>}
 */
async function subscribeToMeetSpace(meetUrl, contactId, { calendarEventTitle, scheduledStart, scheduledEnd } = {}) {
  if (!PUBSUB_TOPIC) {
    console.warn(`${TAG} GOOGLE_CLOUD_PROJECT_ID not set — skipping subscription`);
    return null;
  }
  if (!supabase) {
    console.warn(`${TAG} Supabase not configured — skipping subscription`);
    return null;
  }

  const meetingCode = extractMeetingCode(meetUrl);
  console.log(
    `${TAG} Creating subscription for meeting ${meetingCode}, contact ${contactId}`
  );

  const accessToken = await getAccessToken();
  const authConfig = { headers: { Authorization: `Bearer ${accessToken}` } };

  // 1. Resolve meeting code → space name
  let spaceName;
  try {
    const resp = await axios.get(
      `https://meet.googleapis.com/v2/spaces/${meetingCode}`,
      authConfig
    );
    spaceName = resp.data?.name; // e.g. "spaces/abc-defg-hij"
  } catch (err) {
    console.error(
      `${TAG} Failed to resolve space for ${meetingCode}:`,
      err.response?.data || err.message
    );
    return null;
  }

  if (!spaceName) {
    console.error(`${TAG} No space name returned for ${meetingCode}`);
    return null;
  }

  // 2. Create Workspace Events subscription
  const targetResource = `//meet.googleapis.com/${spaceName}`;

  let subscriptionName = null;
  try {
    const resp = await axios.post(
      "https://workspaceevents.googleapis.com/v1/subscriptions",
      {
        targetResource,
        eventTypes: MEET_EVENT_TYPES,
        notificationEndpoint: { pubsubTopic: PUBSUB_TOPIC },
        ttl: `${SUBSCRIPTION_TTL_SECONDS}s`,
      },
      authConfig
    );

    // Response may be a long-running operation; subscription name is nested
    subscriptionName =
      resp.data?.response?.name || resp.data?.name || null;
    console.log(`${TAG} Subscription created: ${subscriptionName}`);
  } catch (err) {
    console.error(
      `${TAG} Failed to create subscription:`,
      err.response?.data || err.message
    );
    return null;
  }

  // 3. Store space → contact mapping in Supabase
  const expiresAt = new Date(
    Date.now() + SUBSCRIPTION_TTL_SECONDS * 1000
  ).toISOString();

  const { error: insertErr } = await supabase
    .from("meet_event_subscriptions")
    .upsert(
      {
        space_name: spaceName,
        meeting_code: meetingCode,
        contact_id: contactId,
        meet_url: meetUrl,
        subscription_name: subscriptionName,
        status: "active",
        subscription_expires_at: expiresAt,
        calendar_event_title: calendarEventTitle || null,
        scheduled_start: scheduledStart || null,
        scheduled_end: scheduledEnd || null,
      },
      { onConflict: "space_name" }
    );

  if (insertErr) {
    console.error(`${TAG} Failed to store mapping:`, insertErr);
  } else {
    console.log(`${TAG} Stored mapping: ${spaceName} → contact ${contactId}`);
  }

  return { subscriptionName, spaceName };
}

// ---------------------------------------------------------------------------
// lookupContactBySpace
// ---------------------------------------------------------------------------

/**
 * Look up the contactId and meetUrl for a given space name.
 * @param {string} spaceName - e.g. "spaces/abc-defg-hij"
 * @returns {Promise<{contactId: string, meetUrl: string}|null>}
 */
async function lookupContactBySpace(spaceName) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("meet_event_subscriptions")
    .select("contact_id, meet_url")
    .eq("space_name", spaceName)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`${TAG} Error looking up space ${spaceName}:`, error);
    return null;
  }

  return data ? { contactId: data.contact_id, meetUrl: data.meet_url } : null;
}

// ---------------------------------------------------------------------------
// markSubscriptionCompleted
// ---------------------------------------------------------------------------

/**
 * Mark a subscription as completed after artifacts are fetched.
 * @param {string} spaceName
 */
async function markSubscriptionCompleted(spaceName) {
  if (!supabase) return;

  const { error } = await supabase
    .from("meet_event_subscriptions")
    .update({
      status: "completed",
      artifacts_fetched: true,
      artifacts_fetched_at: new Date().toISOString(),
    })
    .eq("space_name", spaceName);

  if (error) {
    console.error(`${TAG} Error marking subscription completed:`, error);
  }
}

module.exports = {
  subscribeToMeetSpace,
  lookupContactBySpace,
  markSubscriptionCompleted,
  MEET_EVENT_TYPES,
};
