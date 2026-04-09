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

  // 4. Send an SMS to the lead confirming receipt.
  // This creates the conversation thread so the artist sees it in the iOS app,
  // and the lead's original message is stored as a contact note.
  const confirmMessage = `Thanks for reaching out to ${artistSlug === "joan" ? "Joan" : "Andrew"} at Studio AZ Tattoo! Your message has been received — expect a reply soon.`;

  const sendResult = await ghlSdk.conversations.createMessage({
    conversationId,
    type: "SMS",
    message: confirmMessage,
    contactId,
  });

  console.log(`✅ Confirmation SMS sent to contact ${contactId}`, {
    conversationId,
    messageId: sendResult?.messageId,
  });

  // 5. Add the lead's original message as a note on the contact
  // so the artist can see exactly what was submitted from the landing page.
  try {
    await ghlSdk.contacts.createNote({
      contactId,
      body: `📩 Landing page inquiry:\n\n"${message}"\n\nSubmitted from studioaztattoo.com/${artistSlug}`,
      userId: artistUserId,
    });
    console.log(`📝 Note added to contact ${contactId}`);
  } catch (noteErr) {
    console.warn(`⚠️ Failed to add note to contact ${contactId}:`, noteErr.message);
  }

  return { success: true, contactId, conversationId };
}

module.exports = { processArtistInquiry, ARTIST_USER_IDS };
