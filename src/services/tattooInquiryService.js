// tattooInquiryService.js
// Handles social landing page form submissions from tattoo artist bio links.
// Flow: upsert GHL contact → assign artist → store message in custom field → create conversation → mark unread

const {
  lookupContactIdByEmailOrPhone,
  createContact,
  assignContactToArtist,
  findConversationForContact,
  updateSystemFields,
} = require("../clients/ghlClient");
const { ghl: ghlSdk } = require("../clients/ghlSdk");

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Custom field ID for "Landing Page Inquiry" — stores the lead's message from the form.
// The iOS app reads this field and renders it as a synthetic inbound bubble in the conversation.
const LANDING_PAGE_INQUIRY_FIELD_ID = "kNJrZsTQhDmILbdqJlo0";

// Map artist slug → GHL user ID
const ARTIST_USER_IDS = {
  joan: "1wuLf50VMODExBSJ9xPI",
  andrew: "O8ChoMYj1BmMWJJsDlvC",
};

/**
 * Process an inquiry from the artist social landing page.
 * 1. Upsert contact with artist as owner
 * 2. Store the lead's message in the landing_page_inquiry custom field
 * 3. Find or create SMS conversation
 * 4. Mark conversation as unread so artist gets notified
 *
 * No SMS is sent — the first text the lead receives is the artist's personal reply.
 * The iOS app reads the custom field and displays it as an inbound bubble.
 */
async function processArtistInquiry({ firstName, lastName, phone, message, artistSlug, source }) {
  const artistUserId = ARTIST_USER_IDS[artistSlug];
  if (!artistUserId) {
    throw new Error(`Unknown artist slug: ${artistSlug}`);
  }

  // 1. Find or create contact
  let contactId = await lookupContactIdByEmailOrPhone(null, phone);

  if (contactId) {
    console.log(`🔁 Found existing GHL contact ${contactId} for phone ${phone}`);
  } else {
    console.log(`🆕 Creating new GHL contact for ${firstName} ${lastName}`);
    const created = await createContact({
      firstName,
      lastName,
      phone,
      source: "Artist Landing Page",
      locationId: GHL_LOCATION_ID,
      assignedTo: artistUserId,
    });

    contactId =
      created?.id ||
      created?._id ||
      created?.contact?.id ||
      created?.contact?._id ||
      null;

    if (!contactId) {
      throw new Error("Failed to create GHL contact — no ID returned");
    }
  }

  // 2. Assign the correct artist as contact owner
  await assignContactToArtist(contactId, artistUserId);

  // 2b. Persist lead source
  await updateSystemFields(contactId, { lead_source: "artist_landing_page" });
  console.log(`📍 [LEAD SOURCE] Set lead_source="artist_landing_page" for ${contactId}`);

  // 3. Store the lead's message in the landing_page_inquiry custom field
  // Format: "[source]message" — iOS app parses the source prefix for attribution
  // source is "instagram", "tiktok", or "bio_link"
  const trafficSource = source || "bio_link";
  const fieldValue = `[${trafficSource}]${message}`;

  try {
    await ghlSdk.contacts.updateContact(
      { contactId },
      {
        customFields: [
          { id: LANDING_PAGE_INQUIRY_FIELD_ID, field_value: fieldValue },
        ],
      }
    );
    console.log(`📩 Landing page inquiry (${trafficSource}) stored for contact ${contactId}`);
  } catch (cfErr) {
    console.error(`❌ Failed to store inquiry in custom field:`, cfErr.message);
    throw cfErr;
  }

  // 4. Find existing SMS conversation or create one
  let conversation = await findConversationForContact(contactId, { typeFilter: "SMS" });
  let conversationId = conversation?.id;

  if (!conversationId) {
    console.log(`💬 No SMS conversation found for contact ${contactId} — creating one`);
    const result = await ghlSdk.conversations.createConversation({
      locationId: GHL_LOCATION_ID,
      contactId,
    });
    conversationId = result?.conversation?.id || result?.id;

    if (!conversationId) {
      throw new Error("Failed to create GHL conversation — no ID returned");
    }
  }

  console.log(`💬 Using conversation ${conversationId} for contact ${contactId}`);

  // 5. Post an internal comment so the conversation preview shows the message.
  // Internal comments don't send SMS but populate lastInternalComment in GHL.
  try {
    await ghlSdk.conversations.sendANewMessage({
      type: "InternalComment",
      message: `📩 ${message}`,
      contactId,
    });
    console.log(`💬 Internal comment posted for conversation preview`);
  } catch (commentErr) {
    console.warn(`⚠️ Could not post internal comment:`, commentErr.message);
  }

  // 6. Mark conversation as unread so the artist gets the notification badge
  try {
    await ghlSdk.conversations.updateConversation(
      { conversationId },
      { locationId: GHL_LOCATION_ID, unreadCount: 1 }
    );
    console.log(`🔔 Conversation ${conversationId} marked as unread`);
  } catch (unreadErr) {
    console.warn(`⚠️ Could not mark conversation as unread:`, unreadErr.message);
  }

  // 6. Add the lead's original message as a note on the contact (backup)
  try {
    await ghlSdk.contacts.createNote(
      { contactId },
      {
        body: `📩 Landing page inquiry:\n\n"${message}"\n\nSubmitted from studioaztattoo.com/${artistSlug}`,
        userId: artistUserId,
      }
    );
    console.log(`📝 Note added to contact ${contactId}`);
  } catch (noteErr) {
    console.warn(`⚠️ Failed to add note to contact ${contactId}:`, noteErr.message);
  }

  return { success: true, contactId, conversationId };
}

module.exports = { processArtistInquiry, ARTIST_USER_IDS };
