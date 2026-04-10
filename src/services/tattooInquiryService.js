// tattooInquiryService.js
// Handles social landing page form submissions from tattoo artist bio links.
// Flow: upsert GHL contact → assign artist → send SMS with lead's message → add note → mark unread

const {
  lookupContactIdByEmailOrPhone,
  createContact,
  assignContactToArtist,
  findConversationForContact,
} = require("../clients/ghlClient");
const { ghl: ghlSdk } = require("../clients/ghlSdk");

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Map artist slug → GHL user ID + first name
const ARTIST_USER_IDS = {
  joan: "1wuLf50VMODExBSJ9xPI",
  andrew: "O8ChoMYj1BmMWJJsDlvC",
};

const ARTIST_NAMES = {
  joan: "Joan",
  andrew: "Andrew",
};

/**
 * Process an inquiry from the artist social landing page.
 * 1. Upsert contact with artist as owner
 * 2. Find or create SMS conversation
 * 3. Send the lead's message as an SMS (appears in conversation thread)
 * 4. Add a contact note with the original inquiry
 * 5. Mark conversation as unread so artist gets notified
 */
async function processArtistInquiry({ firstName, lastName, phone, message, artistSlug }) {
  const artistUserId = ARTIST_USER_IDS[artistSlug];
  const artistName = ARTIST_NAMES[artistSlug];
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

  // 3. Find existing SMS conversation or create one
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

  // 4. Send the lead's message as an SMS with [LP] marker.
  // The [LP] prefix tells the iOS app to render this as an inbound (left-side) bubble.
  // The lead receives the SMS on their phone and can reply directly.
  const smsMessage = `[LP]${message}`;

  const sendResult = await ghlSdk.conversations.sendANewMessage({
    type: "SMS",
    message: smsMessage,
    contactId,
  });

  const sentMessageId = sendResult?.messageId;

  console.log(`✅ SMS sent to contact ${contactId}`, {
    conversationId: sendResult?.conversationId || conversationId,
    messageId: sentMessageId,
  });

  // Use the conversationId from the send result if available
  conversationId = sendResult?.conversationId || conversationId;

  // 5. Mark conversation as unread so the artist gets the notification badge
  try {
    await ghlSdk.conversations.updateConversation(
      { conversationId },
      { locationId: GHL_LOCATION_ID, unreadCount: 1 }
    );
    console.log(`🔔 Conversation ${conversationId} marked as unread`);
  } catch (unreadErr) {
    console.warn(`⚠️ Could not mark conversation as unread:`, unreadErr.message);
  }

  // 6. Add the lead's original message as a note on the contact
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
