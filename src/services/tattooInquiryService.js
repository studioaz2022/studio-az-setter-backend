// tattooInquiryService.js
// Handles social landing page form submissions from tattoo artist bio links.
// Flow: upsert GHL contact → assign artist → store message in custom field → create conversation → mark unread

const {
  lookupContactIdByEmailOrPhone,
  createContact,
  assignContactToArtist,
  findConversationForContact,
  updateSystemFields,
  uploadFilesToTattooCustomField,
} = require("../clients/ghlClient");
const { ghl: ghlSdk } = require("../clients/ghlSdk");
const { createToken: createFillToken } = require("./fillTokenService");
const { sendPushToGhlUser } = require("./taskNotifications");

// Pretty traffic-source labels for the push title. Falls back to the raw slug
// (capitalized) for any source we haven't named yet.
const SOURCE_LABELS_EN = {
  instagram: "Instagram",
  tiktok: "TikTok",
  bio_link: "Bio Link",
};
const SOURCE_LABELS_ES = {
  instagram: "Instagram",
  tiktok: "TikTok",
  bio_link: "Bio Link",
};

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Custom field ID for "Landing Page Inquiry" — stores the lead's message from the form.
// The iOS app reads this field and renders it as a synthetic inbound bubble in the conversation.
const LANDING_PAGE_INQUIRY_FIELD_ID = "kNJrZsTQhDmILbdqJlo0";

// "Last Auto SMS At" — DATE field stamped when the auto-confirmation SMS sends.
// Used by funnel analytics to exclude the auto-SMS from "time to first artist reply"
// (otherwise the auto-SMS would always look like the artist replied instantly).
// See FILL_FLOW_PLAN.md Phase 4.5 — "Distinguishing the auto-confirmation SMS".
const LAST_AUTO_SMS_AT_FIELD_ID = "EjpTbHO59al8yiS2QP7E";

// "Language Preference" — drives EN vs ES copy.
const LANGUAGE_PREFERENCE_FIELD_ID = "ETxasC6QlyxRaKU18kbz";

// Map artist slug → GHL user ID
const ARTIST_USER_IDS = {
  joan: "1wuLf50VMODExBSJ9xPI",
  andrew: "O8ChoMYj1BmMWJJsDlvC",
};

// Display name lookup for auto-SMS personalization.
const ARTIST_FIRST_NAMES = {
  joan: "Joan",
  andrew: "Andrew",
};

// Kill switch — set LANDING_PAGE_AUTO_SMS_ENABLED=false on Render to disable
// auto-SMS without a redeploy (e.g., if the SMS is misbehaving in prod and we
// need to stop it instantly). Default ON.
function autoSmsEnabled() {
  const v = process.env.LANDING_PAGE_AUTO_SMS_ENABLED;
  return v === undefined || v === null || v === "" || v.toLowerCase() !== "false";
}

/**
 * Build the auto-confirmation SMS body. When `fillUrl` is provided (v1 of the
 * fill flow), the copy points the lead at the fill page; otherwise it falls
 * back to the simpler "we got your message" acknowledgment so we can still
 * disable the fill flow via env var without losing the auto-SMS.
 *
 * Copy matches FILL_FLOW_PLAN.md Phase 1 "SMS copy update" section.
 */
function buildAutoSmsBody({ firstName, artistFirstName, language, fillUrl }) {
  const isEs = language === "es" || language === "spanish";
  if (fillUrl) {
    if (isEs) {
      return `Hola ${firstName} — recibí tu mensaje para ${artistFirstName}! Mientras él responde a otros mensajes, llena unos detalles rápidos para agilizar el proceso: ${fillUrl} — Studio AZ`;
    }
    return `Hey ${firstName} — got your message for ${artistFirstName}! While he's responding to other leads, fill in a few quick details to speed things up: ${fillUrl} — Studio AZ`;
  }
  if (isEs) {
    return `Hola ${firstName} — recibí tu mensaje para ${artistFirstName}! Te responderá personalmente en menos de 24 horas. — Studio AZ`;
  }
  return `Hey ${firstName} — got your message for ${artistFirstName}! He'll text you back personally within 24 hours. — Studio AZ`;
}

/**
 * Read the contact's `language_preference` custom field and normalize it to
 * "en" | "es". Returns null when unset so callers can fall back to whatever
 * default they want (the inquiry payload's language, or "en").
 */
async function getContactLanguage(contactId) {
  if (!contactId) return null;
  try {
    const data = await ghlSdk.contacts.getContact({ contactId });
    const contact = data?.contact || data;
    const cf = contact?.customField || {};
    const raw =
      cf[LANGUAGE_PREFERENCE_FIELD_ID] ||
      // Some responses also serialize as customFields array
      (Array.isArray(contact?.customFields)
        ? contact.customFields.find((f) => f.id === LANGUAGE_PREFERENCE_FIELD_ID)?.value ||
          contact.customFields.find((f) => f.id === LANGUAGE_PREFERENCE_FIELD_ID)?.field_value
        : null);
    if (!raw) return null;
    const lower = String(raw).toLowerCase();
    if (lower.includes("span") || lower === "es" || lower === "español") return "es";
    if (lower.includes("eng") || lower === "en") return "en";
    return null;
  } catch (err) {
    console.warn(`⚠️ getContactLanguage(${contactId}) failed:`, err.message);
    return null;
  }
}

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
/**
 * Normalize the form's `language` choice + `pageLang` into:
 *   - `stored`: the value to write to the GHL `language_preference` custom
 *     field. Verbatim from the form ("English" | "Spanish" | "Bilingual"), or
 *     null when no choice was made.
 *   - `outbound`: the language code ("en" | "es") used for the auto-SMS body
 *     and the fill-page initial render. "Bilingual" collapses to `pageLang`.
 *
 * Returns `null` shape when the form didn't send a `language` (older clients,
 * direct API callers) so the caller can fall back to the existing
 * `getContactLanguage()` lookup.
 */
function resolveInquiryLanguage(language, pageLang) {
  if (!language || typeof language !== "string") {
    return { stored: null, outbound: null };
  }
  const fallback = pageLang === "es" ? "es" : "en";
  switch (language) {
    case "Spanish":
      return { stored: "Spanish", outbound: "es" };
    case "English":
      return { stored: "English", outbound: "en" };
    case "Bilingual":
      return { stored: "Bilingual", outbound: fallback };
    default:
      // Unknown value — log but don't block submission. Fall through to the
      // legacy detection path.
      console.warn(`⚠️ resolveInquiryLanguage: unknown choice "${language}"`);
      return { stored: null, outbound: null };
  }
}

async function processArtistInquiry({ firstName, lastName, phone, message, artistSlug, source, language, pageLang, files = [] }) {
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

  // 2c. Upload reference images (if any) to the Tattoo Reference Idea file custom field.
  // Field defaults to GHL_TATTOO_FILE_FIELD_ID env var inside uploadFilesToTattooCustomField.
  if (files && files.length > 0) {
    try {
      console.log(`📎 Uploading ${files.length} reference image(s) to contact ${contactId}`);
      await uploadFilesToTattooCustomField(contactId, files);
      console.log(`✅ Reference images uploaded for contact ${contactId}`);
    } catch (uploadErr) {
      // Don't fail the whole inquiry — log and continue (matches /lead/final behavior)
      console.error(`❌ Reference image upload failed for ${contactId}:`, uploadErr.message);
    }
  }

  // 2d. Resolve the lead's language preference.
  //
  // Order of precedence:
  //   1. Explicit choice from the inquiry form (`language` + `pageLang`).
  //      "English" / "Spanish" / "Bilingual" — fresh signal, beats anything
  //      stored on the contact from a prior interaction. Bilingual collapses
  //      to whatever language the lead's UI was in at submit time.
  //   2. Existing `language_preference` on the contact (legacy path, e.g.,
  //      contacts that came in before this field existed).
  //   3. Default to "en".
  //
  // We persist the form's verbatim choice ("English" / "Spanish" /
  // "Bilingual") to the GHL custom field so artists can see "Bilingual" in
  // the iOS contact profile — that's the whole point of the choice (it tells
  // a Spanish-only artist they can communicate directly with a bilingual
  // lead). The outbound code is what we use for SMS + fill page rendering.
  const resolvedLanguage = resolveInquiryLanguage(language, pageLang);
  let detectedLanguage = resolvedLanguage.outbound;
  if (!detectedLanguage) {
    detectedLanguage = (await getContactLanguage(contactId)) || "en";
  }

  // Persist the form's stored value (when present) to the GHL custom field.
  // Skipped when the form didn't send a choice — leaves any existing value
  // alone so we don't clobber legacy contacts.
  if (resolvedLanguage.stored) {
    try {
      await ghlSdk.contacts.updateContact(
        { contactId },
        {
          customFields: [
            { id: LANGUAGE_PREFERENCE_FIELD_ID, field_value: resolvedLanguage.stored },
          ],
        }
      );
      console.log(
        `🌐 [LANGUAGE] Set language_preference="${resolvedLanguage.stored}" for ${contactId} (outbound=${detectedLanguage})`
      );
    } catch (langErr) {
      console.error(
        `❌ Failed to write language_preference for ${contactId}:`,
        langErr.message
      );
      // Non-fatal — continue with the outbound code we resolved.
    }
  }

  // 2e. Mint a fill-flow token. Lets the lead deep-link into the pre-filled
  // consultation page via the auto-confirmation SMS. Non-fatal: if minting
  // fails the inquiry still completes; SMS falls back to plain copy.
  let fillToken = null;
  let fillUrl = null;
  try {
    const tokenResult = await createFillToken({
      contactId,
      artistSlug,
      language: detectedLanguage,
      source: source || "bio_link",
    });
    fillToken = tokenResult.token;
    fillUrl = tokenResult.url;
    console.log(
      `🔗 [FILL TOKEN] Minted ${fillToken} for contact ${contactId} → ${fillUrl} (lang=${detectedLanguage}, reused=${tokenResult.reused})`
    );
  } catch (tokenErr) {
    console.error(
      `❌ Failed to mint fill token for ${contactId}:`,
      tokenErr.message
    );
  }

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

  // 4b. Auto-confirmation SMS to the lead.
  // - Sent from the assigned artist's GHL number (GHL routes via owner phone)
  //   so the lead's text app threads it with the artist's eventual personal reply.
  // - Embeds the fill-flow URL when the token mint succeeded; otherwise falls
  //   back to plain "we got your message" copy.
  // - Localized via `detectedLanguage` (read from contact.language_preference).
  // - Stamps `last_auto_sms_at` on the contact ONLY after a successful send,
  //   so funnel analytics can subtract the auto-SMS from "time to first reply"
  //   without false positives from failed sends.
  // - Kill-switch via LANDING_PAGE_AUTO_SMS_ENABLED env var.
  let autoSmsSent = false;
  if (autoSmsEnabled()) {
    try {
      const artistFirstName = ARTIST_FIRST_NAMES[artistSlug] ||
        artistSlug.charAt(0).toUpperCase() + artistSlug.slice(1);
      const smsBody = buildAutoSmsBody({
        firstName,
        artistFirstName,
        language: detectedLanguage,
        fillUrl: fillUrl || undefined,
      });

      await ghlSdk.conversations.sendANewMessage({
        type: "SMS",
        contactId,
        message: smsBody,
      });

      // Stamp the timestamp custom field. GHL DATE fields accept ISO strings.
      const sentAtIso = new Date().toISOString();
      try {
        await ghlSdk.contacts.updateContact(
          { contactId },
          {
            customFields: [
              { id: LAST_AUTO_SMS_AT_FIELD_ID, field_value: sentAtIso },
            ],
          }
        );
      } catch (stampErr) {
        // Non-fatal — the SMS already went out; analytics may double-count this
        // contact's "first artist reply" as the auto-SMS, but that's a soft
        // failure compared to losing the SMS itself.
        console.warn(
          `⚠️ Failed to stamp last_auto_sms_at on ${contactId}:`,
          stampErr.message
        );
      }

      autoSmsSent = true;
      console.log(`📱 [AUTO-SMS] Sent to ${firstName} (${contactId}) at ${sentAtIso}`);
    } catch (smsErr) {
      // Don't fail the whole inquiry — the artist still has the conversation
      // and unread badge. Lead just won't get an auto-confirmation.
      console.error(
        `❌ [AUTO-SMS] Failed to send to contact ${contactId}:`,
        smsErr.response?.data || smsErr.message
      );
    }
  } else {
    console.log(`🔇 [AUTO-SMS] Disabled via LANDING_PAGE_AUTO_SMS_ENABLED=false`);
  }

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

  // 6b. Push to the artist. GHL doesn't fire InboundMessage for landing-page
  // submissions (no real inbound SMS, just an internal comment + custom field),
  // so the artist would otherwise get no push when their app is closed.
  // Localized per the artist's stored device language (push_tokens.language).
  try {
    const leadName = [firstName, lastName].filter(Boolean).join(" ") || (
      // Fallback for the rare empty-name case
      undefined
    );
    const messagePreview = (message || "").length > 100
      ? `${message.substring(0, 100)}...`
      : (message || "");
    sendPushToGhlUser(artistUserId, (language) => {
      const isEs = language === "es";
      const sourceLabel = isEs
        ? (SOURCE_LABELS_ES[trafficSource] || trafficSource)
        : (SOURCE_LABELS_EN[trafficSource] || trafficSource);
      const fallbackBody = isEs ? "Nueva consulta de tatuaje" : "New tattoo inquiry";
      const body = leadName
        ? (messagePreview ? `${leadName} · ${messagePreview}` : leadName)
        : (messagePreview || fallbackBody);
      return {
        type: "lead_assigned",
        title: isEs ? `Nuevo Cliente de ${sourceLabel}` : `New Lead from ${sourceLabel}`,
        body,
        badge: 1,
        contactId,
      };
    }).catch((err) => console.error("❌ [LEAD APN] Error:", err.message || err));
  } catch (pushErr) {
    console.error("❌ [LEAD APN] Error setting up push:", pushErr.message || pushErr);
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

  return { success: true, contactId, conversationId, fillToken, fillUrl, autoSmsSent };
}

module.exports = { processArtistInquiry, ARTIST_USER_IDS };
