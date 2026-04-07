// tattooInquiryService.js
// Handles social landing page form submissions from tattoo artist bio links.
// Flow: upsert GHL contact → assign artist → get/create conversation → post inbound SMS

const {
  lookupContactIdByEmailOrPhone,
  createContact,
  assignContactToArtist,
  findConversationForContact,
} = require("../clients/ghlClient");
const { ghl: ghlSdk } = require("../clients/ghlSdk");

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Map artist slug → GHL user ID
const ARTIST_USER_IDS = {
  joan: "1wuLf50VMODExBSJ9xPI",
  andrew: "O8ChoMYj1BmMWJJsDlvC",
};

/**
 * Process an inquiry from the artist social landing page.
 * 1. Upsert contact with artist as owner
 * 2. Find or create SMS conversation
 * 3. Post lead's message as an inbound SMS so it appears as an unread message in the iOS app
 */
async function processArtistInquiry({ firstName, lastName, phone, message, artistSlug }) {
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

  // 4. Post the lead's message as an inbound SMS
  // direction: "inbound" makes it appear as a received message in the iOS app,
  // triggering the unread badge so the artist sees it like a normal incoming text.
  const inboundResult = await ghlSdk.conversations.addAnInboundMessage({
    conversationId,
    type: "SMS",
    message,
    conversationProviderId: "twilio-sms",
    direction: "inbound",
  });

  console.log(`✅ Inbound SMS posted for contact ${contactId}`, {
    conversationId,
    messageId: inboundResult?.messageId,
  });

  return { success: true, contactId, conversationId };
}

module.exports = { processArtistInquiry, ARTIST_USER_IDS };
