require("dotenv").config();

// ghlClient.js
const axios = require("axios");
const FormData = require("form-data");
const { cleanLogObject } = require("./src/utils/logger");

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_FILE_UPLOAD_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN;

// Axios client for GHL v1 API
const ghl = axios.create({
  baseURL: "https://rest.gohighlevel.com", // v1 base
  headers: {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
  },
});

// 🔹 Map widget custom field keys -> actual GHL custom field IDs
// TODO: replace EACH "CF_xxx_FILL_ME" with the real ID from Settings → Custom Fields
const CUSTOM_FIELD_MAP = {
  language_preference: "language_preference",
  inquired_technician: "inquired_technician",
  whatsapp_user: "whatsapp_user",
  tattoo_title: "tattoo_title",
  tattoo_summary: "tattoo_summary",
  tattoo_placement: "tattoo_placement",
  tattoo_style: "tattoo_style",
  size_of_tattoo: "size_of_tattoo",
  tattoo_color_preference: "tattoo_color_preference",
  how_soon_is_client_deciding: "how_soon_is_client_deciding",
  first_tattoo: "first_tattoo",
  tattoo_concerns: "tattoo_concerns",
  tattoo_photo_description: "tattoo_photo_description",
};

// 🔹 System fields for AI Setter state tracking
const SYSTEM_FIELD_MAP = {
  ai_phase: "ai_phase",
  lead_temperature: "lead_temperature",
  language_preference: "language_preference",
  deposit_link_sent: "deposit_link_sent",
  deposit_paid: "deposit_paid",
  square_payment_link_id: "square_payment_link_id",
  last_phase_update_at: "last_phase_update_at",
};



// Convert widget customFields → GHL v1 customField object
function mapCustomFields(widgetFields = {}) {
  const customField = {};

  Object.entries(widgetFields).forEach(([key, value]) => {
    if (value == null || value === "") return;
    const fieldId = CUSTOM_FIELD_MAP[key];
    if (!fieldId) return; // no mapping yet

    customField[fieldId] = value;
  });

  return customField;
}

// Normalize tags & control when "consultation request" appears
function normalizeTags(rawTags = [], mode = "partial") {
  const tags = (Array.isArray(rawTags) ? rawTags : [])
    .filter(Boolean)
    .map((t) => String(t).trim());

  const lowerTarget = "consultation request";

  let result = [...tags];

  if (mode === "partial") {
    // For partial submission, strip the consultation tag so we don't trigger Workflow 1 yet
    result = result.filter((t) => t.toLowerCase() !== lowerTarget);
  } else if (mode === "final") {
    // For final submission, ensure the consultation tag is present
    const has = result.some((t) => t.toLowerCase() === lowerTarget);
    if (!has) {
      result.push("consultation request");
    }
  }

  // Ensure "Source: Web Widget" is present
  if (!result.some((t) => t.toLowerCase().includes("source: web widget"))) {
    result.push("Source: Web Widget");
  }

  // De-dupe
  return Array.from(new Set(result));
}

/**
 * Fetch a contact by ID from GoHighLevel
 * (Used by your /ghl/* webhooks)
 */
async function getContact(contactId) {
  if (!contactId) return null;

  try {
    const res = await axios.get(
      `https://rest.gohighlevel.com/v1/contacts/${contactId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          Accept: "application/json",
        },
      }
    );

    const data = res.data || {};

    // Handle either { contact: {...} } or just {...}
    const contact = data.contact || data;

    return contact;
  } catch (err) {
    console.error(
      "❌ Error fetching contact from GHL:",
      err.response?.status,
      err.response?.data || err.message
    );
    return null;
  }
}

/** Photo Form Data */
async function uploadFilesToTattooCustomField(contactId, files = []) {
  if (!files || files.length === 0) return null;

  const locationId = process.env.GHL_LOCATION_ID;
  const customFieldId = process.env.GHL_TATTOO_FILE_FIELD_ID;

  if (!locationId || !customFieldId) {
    console.warn(
      "⚠️ GHL_LOCATION_ID or GHL_TATTOO_FILE_FIELD_ID missing, skipping file upload."
    );
    return null;
  }

  const form = new FormData();

  files.forEach((file, idx) => {
    const key = `${customFieldId}_${idx + 1}`;
    form.append(key, file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });
  });

  const url = `https://services.leadconnectorhq.com/forms/upload-custom-files?contactId=${contactId}&locationId=${locationId}`;

  console.log(
    "📎 Uploading files to GHL custom field via:",
    url,
    "files:",
    files.length
  );

  const token =
    process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;

  const res = await axios.post(url, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: "2021-07-28",
    },
  });

  console.log(
    "✅ GHL custom file upload response (truncated):",
    JSON.stringify({ status: res.status, contactId }, null, 2)
  );

  return res.data;
}


/**
 * Lookup a contact by email or phone using v1 lookup endpoint
 * https://rest.gohighlevel.com/v1/contacts/lookup?email=john@doe.com
 */
async function lookupContactIdByEmailOrPhone(email, phone) {
  try {
    if (email) {
      const res = await ghl.get("/v1/contacts/lookup", {
        params: { email },
      });

      const data = res.data || {};
      if (Array.isArray(data.contacts) && data.contacts.length > 0) {
        return data.contacts[0].id || data.contacts[0]._id;
      }
      if (data.contact) {
        return data.contact.id || data.contact._id;
      }
      if (data.id || data._id) {
        return data.id || data._id;
      }
    }
  } catch (err) {
    console.warn(
      "⚠️ Email lookup failed:",
      err.response?.status,
      err.response?.data || err.message
    );
  }

  try {
    if (phone) {
      const res = await ghl.get("/v1/contacts/lookup", {
        params: { phone },
      });

      const data = res.data || {};
      if (Array.isArray(data.contacts) && data.contacts.length > 0) {
        return data.contacts[0].id || data.contacts[0]._id;
      }
      if (data.contact) {
        return data.contact.id || data.contact._id;
      }
      if (data.id || data._id) {
        return data.id || data._id;
      }
    }
  } catch (err) {
    console.warn(
      "⚠️ Phone lookup failed:",
      err.response?.status,
      err.response?.data || err.message
    );
  }

  return null;
}

async function createContact(body) {
  const res = await ghl.post("/v1/contacts/", body);
  return res.data;
}

async function updateContact(contactId, body) {
  const res = await ghl.put(`/v1/contacts/${contactId}`, body);
  return res.data;
}

/**
 * Upsert a contact from the widget payload.
 * - mode = "partial" → background create/update, no consultation tag
 * - mode = "final"   → ensure consultation tag present (triggers Workflow 1)
 */
async function upsertContactFromWidget(widgetPayload, mode = "partial") {
  const {
    firstName,
    lastName,
    email,
    phone,
    tags = [],
    customFields = {},
    utm = {},
  } = widgetPayload || {};

  const normalizedTags = normalizeTags(tags, mode);
  const customField = mapCustomFields(customFields);

  const contactBody = {
    firstName,
    lastName,
    email,
    phone,
    tags: normalizedTags,
    customField,
    source: "AI Tattoo Widget",
    // If you later map UTM to real custom fields, you can stuff them into customField above.
  };

  // Try to find existing contact
  const contactId = await lookupContactIdByEmailOrPhone(email, phone);

  if (contactId) {
    console.log(`🔁 Updating existing GHL contact ${contactId} (${mode})`);
    const updated = await updateContact(contactId, contactBody);
    return { contactId, contact: updated };
  } else {
    console.log(`🆕 Creating new GHL contact (${mode})`);
    const created = await createContact(contactBody);

    // Response shape can vary; try to pull out ID safely
    const newId =
      created?.id ||
      created?._id ||
      created?.contact?.id ||
      created?.contact?._id ||
      null;

    return { contactId: newId, contact: created };
  }
}

/**
 * Update AI/system custom fields on a contact
 * Only writes fields that are provided (non-undefined).
 *
 * fields: {
 *   ai_phase?: string,
 *   lead_temperature?: string,
 *   deposit_link_sent?: boolean,
 *   deposit_paid?: boolean,
 *   last_phase_update_at?: string (ISO)
 * }
 */
async function updateSystemFields(contactId, fields = {}) {
  if (!contactId) {
    console.warn("updateSystemFields called without contactId");
    return null;
  }

  const customField = {};

  // 🔹 NEW: language_preference mapping in the right place
  if (
    fields.language_preference !== undefined &&
    SYSTEM_FIELD_MAP.language_preference
  ) {
    customField[SYSTEM_FIELD_MAP.language_preference] =
      fields.language_preference;
  }

  if (fields.ai_phase !== undefined && SYSTEM_FIELD_MAP.ai_phase) {
    customField[SYSTEM_FIELD_MAP.ai_phase] = fields.ai_phase;
  }

  if (
    fields.lead_temperature !== undefined &&
    SYSTEM_FIELD_MAP.lead_temperature
  ) {
    customField[SYSTEM_FIELD_MAP.lead_temperature] =
      fields.lead_temperature;
  }

  if (
    fields.deposit_link_sent !== undefined &&
    SYSTEM_FIELD_MAP.deposit_link_sent
  ) {
    customField[SYSTEM_FIELD_MAP.deposit_link_sent] = fields.deposit_link_sent
      ? "Yes"
      : "No";
  }

  if (fields.deposit_paid !== undefined && SYSTEM_FIELD_MAP.deposit_paid) {
    customField[SYSTEM_FIELD_MAP.deposit_paid] = fields.deposit_paid
      ? "Yes"
      : "No";
  }

  if (
    fields.square_payment_link_id !== undefined &&
    SYSTEM_FIELD_MAP.square_payment_link_id
  ) {
    customField[SYSTEM_FIELD_MAP.square_payment_link_id] =
      fields.square_payment_link_id;
  }

  if (
    fields.last_phase_update_at !== undefined &&
    SYSTEM_FIELD_MAP.last_phase_update_at
  ) {
    customField[SYSTEM_FIELD_MAP.last_phase_update_at] =
      fields.last_phase_update_at;
  }

  if (Object.keys(customField).length === 0) {
    console.log("updateSystemFields: nothing to update");
    return null;
  }

  try {
    const body = { customField };
    const res = await updateContact(contactId, body);
    return res;
  } catch (err) {
    console.error(
      "❌ Error updating system fields in GHL:",
      err.response?.status,
      err.response?.data || err.message
    );
    return null;
  }
}

/**
 * Update tattoo-related custom fields on a contact using the CUSTOM_FIELD_MAP.
 * 
 * @param {string} contactId
 * @param {object} fields - keys like "tattoo_placement", "size_of_tattoo", etc.
 */
async function updateTattooFields(contactId, fields = {}) {
  if (!contactId) {
    console.warn("updateTattooFields called without contactId");
    return null;
  }

  if (!fields || typeof fields !== "object") {
    console.warn("updateTattooFields called with invalid fields:", fields);
    return null;
  }

  // Map from friendly keys → actual GHL customField IDs
  const customField = {};

  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;

    const fieldId = CUSTOM_FIELD_MAP[key];
    if (!fieldId) return; // no mapping defined for this key

    let outboundValue = value;

    // Special handling: first_tattoo is a TEXT field in GHL, but we keep it boolean in AI.
    if (key === "first_tattoo") {
      if (typeof value === "boolean") {
        outboundValue = value ? "Yes" : "No";
      } else if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (["yes", "y", "true", "si", "sí"].includes(v)) {
          outboundValue = "Yes";
        } else if (["no", "n", "false"].includes(v)) {
          outboundValue = "No";
        } else {
          // fall back to the raw string if it's something unexpected
          outboundValue = value;
        }
      }
    }

    customField[fieldId] = outboundValue;
  });

  if (Object.keys(customField).length === 0) {
    console.log("updateTattooFields: no mapped fields to update for contact", contactId);
    return null;
  }

  try {
    const body = { customField };
    const res = await updateContact(contactId, body);
    console.log("✅ Updated tattoo fields for contact", contactId, "with", customField);
    return res;
  } catch (err) {
    console.error(
      "❌ Error updating tattoo fields in GHL:",
      err.response?.status,
      err.response?.data || err.message
    );
    return null;
  }
}

// Search for conversations for a contact and return the most recent one
async function findConversationForContact(contactId) {
  if (!contactId) return null;

  const url = `https://services.leadconnectorhq.com/conversations/search?locationId=${encodeURIComponent(
    GHL_LOCATION_ID
  )}&contactId=${encodeURIComponent(contactId)}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
        Accept: "application/json",
        Version: "2021-04-15",
      },
    });

    const convs = resp.data?.conversations || [];
    if (!convs.length) {
      return null;
    }

    // Return the most recent conversation (they're sorted newest-first)
    return convs[0];
  } catch (err) {
    console.error(
      "findConversationForContact: error calling /conversations/search:",
      err.response?.data || err.message
    );
    return null;
  }
}

// Infer the outbound "type" for /conversations/messages by looking at the last inbound message
async function inferConversationMessageType(contactId) {
  if (!contactId) return "SMS";

  const conversation = await findConversationForContact(contactId);
  if (!conversation) {
    console.warn("inferConversationMessageType: no conversations found, defaulting to SMS");
    return "SMS";
  }

  // Check conversation type first - if it's SMS, return SMS (don't infer DM type)
  const conversationType = (conversation.type || "").toUpperCase();
  if (conversationType.includes("SMS")) {
    return "SMS";
  }

  // For DM conversations, check contact's actual social IDs first
  try {
    const contact = await getContact(contactId);
    // Check for social media IDs in contact object
    // GHL stores these in various fields - check common patterns
    const hasInstagramId = !!(
      contact?.instagramId || 
      contact?.instagram || 
      contact?.socialProfiles?.instagram ||
      contact?.customField?.instagram_id
    );
    const hasFacebookId = !!(
      contact?.facebookId || 
      contact?.facebook || 
      contact?.socialProfiles?.facebook ||
      contact?.customField?.facebook_id
    );
    
    if (hasInstagramId) {
      return "IG";
    }
    if (hasFacebookId) {
      return "FB";
    }
  } catch (err) {
    console.warn("Error checking contact for type inference:", err.message);
  }

  const lastType = conversation.lastMessageType || conversation.type || "";

  if (!lastType || typeof lastType !== "string") {
    console.warn(
      "inferConversationMessageType: no lastMessageType on conversation, defaulting to SMS"
    );
    return "SMS";
  }

  const t = lastType.toUpperCase();

  // Map GHL lastMessageType → Conversations API "type" enum
  if (t.includes("INSTAGRAM")) {
    return "IG";
  }
  if (t.includes("FACEBOOK")) {
    return "FB";
  }
  if (t.includes("WHATSAPP")) {
    return "WhatsApp";
  }
  if (t.includes("GMB")) {
    return "GMB";
  }
  if (t.includes("WEBCHAT") || t.includes("LIVE_CHAT")) {
    return "Live_Chat";
  }
  if (t.includes("EMAIL")) {
    return "Email";
  }
  if (t.includes("SMS") || t.includes("PHONE") || t.includes("CALL") || t.includes("CUSTOM_SMS")) {
    return "SMS";
  }

  // Fallback - prefer FB over IG for DM contexts (more common, and less likely to fail)
  console.warn(
    `inferConversationMessageType: unrecognized lastMessageType=${lastType}, defaulting to FB for DM`
  );
  return "FB";
}

// Send a message in a contact's conversation
async function sendConversationMessage({ contactId, body, channelContext = {} }) {
  if (!contactId) {
    throw new Error("contactId is required for sendConversationMessage");
  }
  if (!body || !body.trim()) {
    console.warn("sendConversationMessage called with empty body, skipping.");
    return null;
  }

  const {
    isDm = false,
    hasPhone = false,
    conversationId = null,
    phone = null,
  } = channelContext;

  console.log("✉️ sendConversationMessage context:", cleanLogObject({
    contactId,
    isDm,
    hasPhone,
    conversationId,
  }));

  // 1) DM reply path (no phone required)
  if (isDm) {
    // If no conversationId provided, try to find existing conversation
    let finalConversationId = conversationId;
    let dmType = null;

    let foundConversation = null;
    if (!finalConversationId) {
      console.log("🔍 No conversationId provided for DM, searching for existing conversation...");
      foundConversation = await findConversationForContact(contactId);
      if (foundConversation) {
        finalConversationId = foundConversation.id || foundConversation._id;
        
        // Check if this is actually a DM conversation (not SMS)
        const convType = (foundConversation.type || "").toUpperCase();
        if (convType.includes("SMS")) {
          console.warn("⚠️ Conversation type is SMS, but isDm=true. This might be a mismatch.");
          // Don't try to send SMS conversations as DM - fall through to error handling
        } else {
          // If we found an existing conversation, infer type from the conversation itself first
          // Trust GHL's conversation type - if it exists, GHL knows how to send to it
          const lastType = (foundConversation.lastMessageType || foundConversation.type || "").toUpperCase();
          if (lastType.includes("INSTAGRAM")) {
            dmType = "IG";
          } else if (lastType.includes("FACEBOOK")) {
            dmType = "FB";
          } else {
            // Fall back to inference function if conversation type is unclear
            dmType = await inferConversationMessageType(contactId);
          }
          console.log(`✅ Found existing conversation ${finalConversationId} with type ${dmType}`);
        }
      }
    } else {
      // If conversationId was provided, still infer the type
      dmType = await inferConversationMessageType(contactId);
    }

    // If we have a conversationId and valid DM type, use it
    if (finalConversationId && dmType && dmType !== "SMS") {
      // If we found the conversation from GHL, trust that GHL knows the type
      // Only validate contact IDs if we're inferring from other sources
      const shouldValidateIds = !foundConversation; // Only validate if we didn't find conversation from GHL
      
      if (shouldValidateIds) {
        // Get contact once to check tags and social IDs
        let contact = null;
        try {
          contact = await getContact(contactId);
        } catch (err) {
          console.error("❌ Error fetching contact for DM validation:", err.message);
          throw err;
        }
        
        // Helper function to check social IDs
        const checkSocialIds = (contact) => {
          const hasInstagramId = !!(
            contact?.instagramId || 
            contact?.instagram || 
            contact?.socialProfiles?.instagram ||
            contact?.customField?.instagram_id
          );
          const hasFacebookId = !!(
            contact?.facebookId || 
            contact?.facebook || 
            contact?.socialProfiles?.facebook ||
            contact?.customField?.facebook_id
          );
          return { hasInstagramId, hasFacebookId };
        };
        
        // Ensure we have a valid type (IG or FB for social media DMs)
        if (dmType !== "IG" && dmType !== "FB") {
          // Try to infer from contact tags or check contact's social IDs
          const tags = contact?.tags || [];
          const hasInstagram = tags.some(t => String(t).toUpperCase().includes("INSTAGRAM"));
          const hasFacebook = tags.some(t => String(t).toUpperCase().includes("FACEBOOK"));
          
          const { hasInstagramId, hasFacebookId } = checkSocialIds(contact);
          
          if (hasInstagramId || (hasInstagram && !hasFacebookId)) {
            dmType = "IG";
          } else if (hasFacebookId || hasFacebook) {
            dmType = "FB";
          } else {
            // Default to FB as fallback (more common than IG, less likely to fail)
            dmType = "FB";
          }
        }
        
        // Validate that contact has the required social ID before sending
        const { hasInstagramId, hasFacebookId } = checkSocialIds(contact);
        
        if (dmType === "IG") {
          if (!hasInstagramId) {
            console.warn("⚠️ Contact has no Instagram ID, switching to FB");
            if (hasFacebookId) {
              dmType = "FB";
            } else {
              console.error("❌ Contact has no Instagram or Facebook ID, cannot send DM");
              throw new Error("Contact has no social media ID for DM sending");
            }
          }
        } else if (dmType === "FB") {
          if (!hasFacebookId) {
            console.warn("⚠️ Contact has no Facebook ID, switching to IG");
            if (hasInstagramId) {
              dmType = "IG";
            } else {
              console.error("❌ Contact has no Facebook or Instagram ID, cannot send DM");
              throw new Error("Contact has no social media ID for DM sending");
            }
          }
        }
      } else {
        // We found the conversation from GHL - trust that GHL knows the type
        console.log(`✅ Using conversation type ${dmType} from GHL conversation - skipping ID validation`);
      }

      try {
        const payload = {
          conversationId: finalConversationId,
          contactId,
          message: body,
          type: dmType, // Use inferred type (IG or FB)
        };

        console.log("📨 Sending DM reply via GHL:", payload);

        const url = "https://services.leadconnectorhq.com/conversations/messages";
        const resp = await axios.post(url, payload, {
          headers: {
            Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            Version: "2021-07-28",
          },
        });

        console.log("📨 GHL DM reply response:", {
          status: resp.status,
          contactId,
          conversationId: finalConversationId,
        });

        return resp.data;
      } catch (err) {
        console.error("❌ Error sending DM reply via GHL:", err.response?.data || err.message);
        // fall through to try alternative method
      }
    }

    // If no conversationId found, try to infer type and send without conversationId
    // GHL will create a new conversation if needed
    if (!finalConversationId) {
      try {
        // Infer DM type from contact tags or default to IG/FB
        const inferredType = await inferConversationMessageType(contactId);
        
        // Only proceed if it's a social media type
        if (inferredType === "IG" || inferredType === "FB") {
          const payload = {
            contactId,
            locationId: GHL_LOCATION_ID,
            message: body,
            type: inferredType,
          };

          console.log("📨 Sending DM via GHL (creating new conversation):", payload);

          const url = "https://services.leadconnectorhq.com/conversations/messages";
          const resp = await axios.post(url, payload, {
            headers: {
              Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
              "Content-Type": "application/json",
              Accept: "application/json",
              Version: "2021-07-28",
            },
          });

          console.log("📨 GHL DM message response (new conversation):", {
            status: resp.status,
            contactId,
            type: inferredType,
          });

          return resp.data;
        } else {
          console.warn(
            `⚠️ Cannot send DM: inferred type is ${inferredType}, not IG/FB. Contact may need to initiate conversation first.`
          );
        }
      } catch (err) {
        console.error("❌ Error sending DM via GHL (new conversation):", err.response?.data || err.message);
        // fall through to error handling
      }
    }
  }

  // 2) SMS / phone-based path (existing behavior)
  if (hasPhone && phone) {
    try {
      // Infer type (SMS / FB / IG / WhatsApp / Email / etc.)
      const type = await inferConversationMessageType(contactId);

      const payload = {
        contactId,
        locationId: GHL_LOCATION_ID,
        message: body,
        type, // e.g. "SMS", "FB", "IG", ...
      };

      const url = "https://services.leadconnectorhq.com/conversations/messages";

      const resp = await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Version: "2021-07-28",
        },
      });

      console.log("📨 GHL conversations API response:", {
        status: resp.status,
        contactId,
        type,
      });

      return resp.data;
    } catch (err) {
      console.error("❌ Error sending SMS/phone message via GHL:", err.response?.data || err.message);
      throw err;
    }
  } else {
    // Fallback: try to infer type and send anyway (existing behavior for backward compatibility)
    if (!isDm) {
      try {
        const type = await inferConversationMessageType(contactId);

        const payload = {
          contactId,
          locationId: GHL_LOCATION_ID,
          message: body,
          type,
        };

        const url = "https://services.leadconnectorhq.com/conversations/messages";

        const resp = await axios.post(url, payload, {
          headers: {
            Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            Version: "2021-07-28",
          },
        });

        console.log("📨 GHL conversations API response (fallback):", {
          status: resp.status,
          contactId,
          type,
        });

        return resp.data;
      } catch (err) {
        console.error("❌ Error sending message via GHL (fallback):", err.response?.data || err.message);
        throw err;
      }
    } else {
      // This should not happen now since DM handling is above, but keep as safety net
      console.warn(
        "⚠️ No valid phone number and no DM conversationId; cannot send message.",
        { contactId, isDm, hasPhone, conversationId }
      );
      return null;
    }
  }
}






module.exports = {
  getContact,
  upsertContactFromWidget,
  updateSystemFields,
  updateTattooFields,
  uploadFilesToTattooCustomField,
  sendConversationMessage,
};


