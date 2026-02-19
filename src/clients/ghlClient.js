require("dotenv").config();

// ghlClient.js — powered by @gohighlevel/api-client SDK
const axios = require("axios"); // Retained for: uploadFilesToTattooCustomField (multipart FormData upload)
const FormData = require("form-data");
const { ghl: ghlSdk } = require("./ghlSdk");
const { cleanLogObject, COMPACT_MODE, shortId } = require("../utils/logger");
const { SYSTEM_FIELDS } = require("../config/constants");

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_FILE_UPLOAD_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN;

// AI message marker: double-space appended to AI-sent messages
// iOS app uses this to detect and display "AI Response ✓" indicator
// Using double-space instead of zero-width space to avoid UCS-2 encoding (which doubles SMS costs)
const AI_MESSAGE_MARKER = "  ";

// AI Bot user ID in GHL - used to identify AI-sent messages in iOS app
// iOS app checks message.userId to show "AI Response ✓" indicator
// This is more reliable than text markers since GHL trims trailing spaces in SMS
const AI_BOT_USER_ID = "3dsbsgZpCWrDYCFPvhKu";

// ============================================================================
// Custom Field Format Conversion Utilities
// ============================================================================

/**
 * Convert v1 customField object → v2 customFields array
 * Used before sending to GHL v2 API (which rejects the v1 format)
 * { "fieldId": "value" } → [{ id: "fieldId", field_value: "value" }]
 */
function customFieldToV2(customFieldObj) {
  if (!customFieldObj || typeof customFieldObj !== "object") return undefined;
  if (Array.isArray(customFieldObj)) return customFieldObj; // already v2
  return Object.entries(customFieldObj).map(([id, value]) => ({
    id,
    field_value: typeof value === "string" ? value : String(value),
  }));
}

/**
 * Normalize contact response: ensure both customField (object) and customFields (array) exist
 * So callers using either format continue to work
 */
function normalizeContactCustomFields(contact) {
  if (!contact) return contact;

  // If v2 array exists but v1 object doesn't, build v1 object
  if (Array.isArray(contact.customFields) && !contact.customField) {
    contact.customField = {};
    for (const cf of contact.customFields) {
      if (cf.id) contact.customField[cf.id] = cf.value;
    }
  }

  // If v1 object exists but v2 array doesn't, build v2 array
  if (contact.customField && typeof contact.customField === "object" && !Array.isArray(contact.customFields)) {
    contact.customFields = Object.entries(contact.customField).map(([id, value]) => ({
      id,
      value: typeof value === "string" ? value : String(value),
    }));
  }

  return contact;
}

/**
 * Transform a contact update/create body: convert customField → customFields for v2 API
 */
function transformBodyForV2(body) {
  if (!body) return body;
  if (body.customField && !body.customFields) {
    body.customFields = customFieldToV2(body.customField);
    delete body.customField;
  }
  return body;
}

// ============================================================================
// Temporary Reassignment Workflow for AI Messages
// ============================================================================

/**
 * Temporarily reassign contact to AI Bot, send message, then reassign back
 * This is necessary because GHL only allows sending messages with userId of the assigned user
 */
async function temporaryReassignForAIMessage(contactId, originalAssignedTo) {
  if (!contactId) return null;

  // Reassign to AI Bot temporarily via SDK
  await ghlSdk.contacts.updateContact(
    { contactId },
    { assignedTo: AI_BOT_USER_ID }
  );

  if (!COMPACT_MODE) console.log(`🔄 Temporarily reassigned contact ${contactId} to AI Bot`);

  return originalAssignedTo; // Return for reassigning back later
}

/**
 * Reassign contact back to original artist after AI message sent
 */
async function reassignToOriginalArtist(contactId, originalAssignedTo) {
  if (!contactId || !originalAssignedTo) return;

  try {
    await ghlSdk.contacts.updateContact(
      { contactId },
      { assignedTo: originalAssignedTo }
    );

    if (!COMPACT_MODE) console.log(`🔄 Reassigned contact ${contactId} back to original artist: ${originalAssignedTo}`);
  } catch (err) {
    console.error("❌ Error reassigning back to original artist:", err.response?.data || err.message);
    // Don't throw - message was already sent successfully
  }
}

// ============================================================================
// Pure Helpers (no API calls, unchanged)
// ============================================================================

/**
 * Check if phone number is a U.S. number based on country code.
 */
function isUSPhoneNumber(phone) {
  if (!phone) return true; // Default to US if no phone

  const cleanedPhone = phone.replace(/[^0-9+]/g, '');

  if (cleanedPhone.startsWith('+1') && cleanedPhone.length >= 12) return true;
  if (cleanedPhone.startsWith('1') && cleanedPhone.length === 11) return true;
  if (!cleanedPhone.startsWith('+') && cleanedPhone.length === 10) return true;
  if (cleanedPhone.startsWith('+') && !cleanedPhone.startsWith('+1')) return false;

  return true;
}

// 🔹 Map widget custom field keys -> actual GHL custom field IDs
const CUSTOM_FIELD_MAP = {
  language_preference: "ETxasC6QlyxRaKU18kbz",
  inquired_technician: "H3PSN8tZSw1kYckHJN9D",
  whatsapp_user: "FnYDobmYqnXDxlLJY5oe",
  tattoo_title: "8JqgdVJraABsqgUeqJ3a",
  tattoo_summary: "xAGtMfmbxtfCHdo2oyf7",
  tattoo_placement: "jd8YhvKsBi4aGqjqOEOv",
  tattoo_style: "12b2O4ydlfO99FA4yCuk",
  tattoo_size: "KXtfZYdeSKUyS5llTKsr",
  tattoo_color_preference: "SzyropMDMcitUDhhb8dd",
  how_soon_is_client_deciding: "ra4Nk80WMA8EQkLCfXST",
  first_tattoo: "QqDydmY1fnldidlcMnBC",
  tattoo_concerns: "tattoo_concerns",
  tattoo_photo_description: "ptrJy8TBBjlnRWQepdnP",
  consultation_type: "gM2PVo90yNBDHekV5G64",
};

// 🔹 Reverse mapping: GHL field ID -> friendly name
const GHL_FIELD_ID_TO_NAME = Object.fromEntries(
  Object.entries(CUSTOM_FIELD_MAP).map(([name, id]) => [id.toLowerCase(), name])
);

// 🔹 System fields for AI Setter state tracking
const SYSTEM_FIELD_MAP = Object.values(SYSTEM_FIELDS || {}).reduce((acc, fieldId) => {
  if (fieldId) {
    acc[fieldId] = fieldId;
  }
  return acc;
}, {});

// Convert widget customFields → GHL customField object
function mapCustomFields(widgetFields = {}) {
  const customField = {};
  Object.entries(widgetFields).forEach(([key, value]) => {
    if (value == null || value === "") return;
    const fieldId = CUSTOM_FIELD_MAP[key];
    if (!fieldId) return;
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
    result = result.filter((t) => t.toLowerCase() !== lowerTarget);
  } else if (mode === "final") {
    const has = result.some((t) => t.toLowerCase() === lowerTarget);
    if (!has) result.push("consultation request");
  }

  if (!result.some((t) => t.toLowerCase().includes("source: web widget"))) {
    result.push("Source: Web Widget");
  }

  return Array.from(new Set(result));
}

// ============================================================================
// Contact Operations (migrated from v1 axios to SDK)
// ============================================================================

/**
 * Fetch a contact by ID from GoHighLevel
 */
async function getContact(contactId) {
  if (!contactId) return null;

  try {
    // SDK returns response.data directly: { contact: {...}, traceId }
    const data = await ghlSdk.contacts.getContact({ contactId });
    const contact = data?.contact || data;

    // Normalize: ensure both customField (object) and customFields (array) exist
    normalizeContactCustomFields(contact);

    return contact;
  } catch (err) {
    console.error(
      "❌ Error fetching contact from GHL:",
      err.response?.status || err.statusCode,
      err.response?.data || err.message
    );
    return null;
  }
}

/**
 * Fetch a contact by ID from GoHighLevel using API v2
 * This version includes followers array which is not available in v1
 */
const getContactV2 = getContact; // Both now use the same SDK v2 endpoint

/** Photo Form Data — No SDK method, uses raw httpClient */
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
    if (!file.buffer || file.buffer.length === 0) {
      console.warn(`⚠️ Skipping file ${idx}: empty buffer (${file.originalname})`);
      return;
    }
    const key = `${customFieldId}_${idx + 1}`;
    form.append(key, file.buffer, {
      filename: file.originalname || `photo_${idx + 1}.jpg`,
      contentType: file.mimetype || "image/jpeg",
    });
  });

  const url = `https://services.leadconnectorhq.com/forms/upload-custom-files?contactId=${contactId}&locationId=${locationId}`;

  // Log file details for debugging
  console.log(
    "📎 Uploading files to GHL custom field via:",
    url,
    "files:",
    files.map(f => ({ name: f.originalname, size: f.size, type: f.mimetype }))
  );

  try {
    const res = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
        Accept: "application/json",
        Version: "2021-07-28",
      },
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
    });

    console.log(
      "✅ GHL custom file upload response:",
      JSON.stringify({ status: res.status, contactId }, null, 2)
    );

    return res.data;
  } catch (uploadErr) {
    console.error("❌ GHL file upload failed:", {
      status: uploadErr.response?.status,
      data: uploadErr.response?.data,
      message: uploadErr.message,
      fileCount: files.length,
      fileSizes: files.map(f => f.size),
    });
    throw uploadErr;
  }
}

/**
 * Lookup a contact by email or phone
 * Uses SDK getDuplicateContact (v2 equivalent of v1 lookup)
 */
async function lookupContactIdByEmailOrPhone(email, phone) {
  // Sanitize email — strip spaces (v2 API is strict)
  const cleanEmail = email ? email.replace(/\s+/g, "").trim() : null;

  try {
    if (cleanEmail) {
      const data = await ghlSdk.contacts.getDuplicateContact({
        locationId: GHL_LOCATION_ID,
        email: cleanEmail,
      });

      // Extract contact ID from response — handles various shapes
      if (data?.contact) {
        return data.contact.id || data.contact._id;
      }
      if (data?.id || data?._id) {
        return data.id || data._id;
      }
    }
  } catch (err) {
    console.warn(
      "⚠️ Email lookup failed:",
      err.response?.status || err.statusCode,
      err.response?.data || err.message
    );
  }

  try {
    if (phone) {
      const data = await ghlSdk.contacts.getDuplicateContact({
        locationId: GHL_LOCATION_ID,
        number: phone,
      });

      if (data?.contact) {
        return data.contact.id || data.contact._id;
      }
      if (data?.id || data?._id) {
        return data.id || data._id;
      }
    }
  } catch (err) {
    console.warn(
      "⚠️ Phone lookup failed:",
      err.response?.status || err.statusCode,
      err.response?.data || err.message
    );
  }

  return null;
}

async function createContact(body) {
  // Transform customField → customFields for v2 API
  const v2Body = transformBodyForV2({ ...body });
  // Ensure locationId is set
  if (!v2Body.locationId) v2Body.locationId = GHL_LOCATION_ID;

  // Sanitize email — v2 API is strict about format (v1 was lenient)
  if (v2Body.email) {
    v2Body.email = v2Body.email.replace(/\s+/g, "").trim();
    // If still not a valid email after cleanup, remove it to avoid 422
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v2Body.email)) {
      console.warn(`⚠️ Invalid email removed from createContact: "${v2Body.email}"`);
      delete v2Body.email;
    }
  }

  // SDK returns response.data directly
  return ghlSdk.contacts.createContact(v2Body);
}

async function updateContact(contactId, body) {
  // Transform customField → customFields for v2 API
  const v2Body = transformBodyForV2({ ...body });

  // Sanitize email — v2 API is strict about format
  if (v2Body.email) {
    v2Body.email = v2Body.email.replace(/\s+/g, "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v2Body.email)) {
      console.warn(`⚠️ Invalid email removed from updateContact: "${v2Body.email}"`);
      delete v2Body.email;
    }
  }

  // SDK returns response.data directly
  return ghlSdk.contacts.updateContact({ contactId }, v2Body);
}

/**
 * Create a task on a contact using GHL v2 API
 */
async function createTaskForContact(contactId, task = {}) {
  if (!contactId) throw new Error("contactId is required to create a task");

  // Set dueDate to tomorrow if not provided (v2 API requires it)
  let dueDate = task.dueDate || null;
  if (!dueDate) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    dueDate = tomorrow.toISOString();
  }

  const payload = {
    title: task.title || "Consultation follow-up",
    body: task.description || task.body || "",
    dueDate: dueDate,
    completed: task.completed !== undefined ? task.completed : false,
    assignedTo: task.assignedTo || null,
  };

  // SDK returns response.data directly
  return ghlSdk.contacts.createTask({ contactId }, payload);
}

/**
 * Update the CRM owner (assigned user) for a contact.
 */
async function updateContactAssignedUser(contactId, assignedUserId) {
  if (!contactId || !assignedUserId) {
    console.warn("updateContactAssignedUser missing contactId or assignedUserId");
    return null;
  }

  try {
    const res = await updateContact(contactId, { assignedUserId });
    console.log(
      "✅ Updated contact owner",
      cleanLogObject({ contactId, assignedUserId })
    );
    return res;
  } catch (err) {
    console.error(
      "❌ Error updating assigned user in GHL:",
      err.response?.status || err.statusCode,
      err.response?.data || err.message
    );
    return null;
  }
}

/**
 * Upsert a contact from the widget payload.
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
 */
async function updateSystemFields(contactId, fields = {}) {
  if (!contactId) {
    console.warn("updateSystemFields called without contactId");
    return null;
  }

  const customField = {};

  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined) return;
    const fieldId = SYSTEM_FIELD_MAP[key] || key;
    if (!fieldId) return;

    let outboundValue = value;
    if (typeof outboundValue === "boolean") {
      outboundValue = outboundValue ? "Yes" : "No";
    }

    customField[fieldId] = outboundValue;
  });

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
      err.response?.status || err.statusCode,
      err.response?.data || err.message
    );
    return null;
  }
}

/**
 * Update tattoo-related custom fields on a contact using the CUSTOM_FIELD_MAP.
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

  const customField = {};

  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;

    const fieldId = CUSTOM_FIELD_MAP[key];
    if (!fieldId) return;

    let outboundValue = value;

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
      err.response?.status || err.statusCode,
      err.response?.data || err.message
    );
    return null;
  }
}

// ============================================================================
// Conversation Operations
// ============================================================================

// Search for conversations for a contact
async function findConversationForContact(contactId, { preferDm = false, typeFilter = null } = {}) {
  if (!contactId) return null;

  try {
    // SDK returns response.data directly: { conversations: [...], total, traceId }
    const data = await ghlSdk.conversations.searchConversation({
      locationId: GHL_LOCATION_ID,
      contactId,
    });

    const convs = data?.conversations || [];
    if (!convs.length) return null;

    const isDmConversation = (conv) => {
      const type = (conv.type || conv.lastMessageType || "").toUpperCase();
      return type.includes("FACEBOOK") || type.includes("FB") ||
             type.includes("INSTAGRAM") || type.includes("IG") ||
             type.includes("MESSENGER");
    };

    const isSmsConversation = (conv) => {
      const type = (conv.type || conv.lastMessageType || "").toUpperCase();
      return type.includes("SMS");
    };

    if (typeFilter === "DM") {
      const dmConv = convs.find(isDmConversation);
      if (dmConv) {
        if (!COMPACT_MODE) console.log(`🔍 Found DM conversation: ${dmConv.id} (type: ${dmConv.type || dmConv.lastMessageType})`);
        return dmConv;
      }
      if (!COMPACT_MODE) console.log("🔍 No DM conversation found for contact");
      return null;
    }

    if (typeFilter === "SMS") {
      const smsConv = convs.find(isSmsConversation);
      if (smsConv) {
        if (!COMPACT_MODE) console.log(`🔍 Found SMS conversation: ${smsConv.id}`);
        return smsConv;
      }
      if (!COMPACT_MODE) console.log("🔍 No SMS conversation found for contact");
      return null;
    }

    if (preferDm) {
      const dmConv = convs.find(isDmConversation);
      if (dmConv) {
        if (!COMPACT_MODE) console.log(`🔍 Preferring DM conversation: ${dmConv.id} (type: ${dmConv.type || dmConv.lastMessageType})`);
        return dmConv;
      }
      if (!COMPACT_MODE) console.log("🔍 No DM conversation found, falling back to most recent");
    }

    return convs[0];
  } catch (err) {
    console.error(
      "findConversationForContact: error calling /conversations/search:",
      err.response?.data || err.message
    );
    return null;
  }
}

/**
 * Fetch conversation history for a contact from GHL
 * NOTE: No SDK method for /conversations/messages/export — uses SDK's httpClient
 */
async function getConversationHistory(contactId, {
  limit = 50,
  channel = null,
  sortOrder = "desc",
} = {}) {
  if (!contactId) {
    console.warn("getConversationHistory called without contactId");
    return [];
  }

  const params = new URLSearchParams({
    locationId: GHL_LOCATION_ID,
    contactId,
    limit: String(Math.max(10, Math.min(limit, 500))),
    sortBy: "createdAt",
    sortOrder,
  });

  if (channel) {
    params.append("channel", channel);
  }

  try {
    // Use SDK's pre-configured httpClient (has auth headers)
    const httpClient = ghlSdk.getHttpClient();
    const resp = await httpClient.get(`/conversations/messages/export?${params}`);

    const messages = resp.data?.messages || [];
    if (!COMPACT_MODE) console.log(`📜 Fetched ${messages.length} messages for contact ${contactId}`);
    return messages;
  } catch (err) {
    console.error(
      "❌ Error fetching conversation history from GHL:",
      err.response?.status,
      err.response?.data || err.message
    );
    return [];
  }
}

// Infer the outbound "type" for /conversations/messages
async function inferConversationMessageType(contactId, { preferDm = false } = {}) {
  if (!contactId) return "SMS";

  if (preferDm) {
    try {
      const contact = await getContact(contactId);
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

      const tags = contact?.tags || [];
      const tagsLower = Array.isArray(tags) ? tags.map(t => String(t).toLowerCase()) : [];
      const hasInstagramTag = tagsLower.some(t => t.includes("instagram") || t.includes("ig"));
      const hasFacebookTag = tagsLower.some(t => t.includes("facebook") || t.includes("fb") || t.includes("messenger"));

      if (hasInstagramId || hasInstagramTag) {
        if (!COMPACT_MODE) console.log("inferConversationMessageType: found Instagram from contact, returning IG");
        return "IG";
      }
      if (hasFacebookId || hasFacebookTag) {
        if (!COMPACT_MODE) console.log("inferConversationMessageType: found Facebook from contact, returning FB");
        return "FB";
      }
    } catch (err) {
      console.warn("Error checking contact for type inference:", err.message);
    }
  }

  const searchOptions = preferDm ? { typeFilter: "DM" } : {};
  const conversation = await findConversationForContact(contactId, searchOptions);

  if (!conversation) {
    if (preferDm) {
      if (!COMPACT_MODE) console.warn("inferConversationMessageType: no DM conversation found, checking contact tags...");
      try {
        const contact = await getContact(contactId);
        const tags = contact?.tags || [];
        const tagsLower = Array.isArray(tags) ? tags.map(t => String(t).toLowerCase()) : [];

        if (tagsLower.some(t => t.includes("instagram") || t.includes("ig"))) return "IG";
        if (tagsLower.some(t => t.includes("facebook") || t.includes("fb") || t.includes("messenger") || t.includes("dm"))) return "FB";
      } catch (err) {
        console.warn("Error checking contact tags:", err.message);
      }
    }
    if (!COMPACT_MODE) console.warn("inferConversationMessageType: no conversations found, defaulting to SMS");
    return "SMS";
  }

  const conversationType = (conversation.type || "").toUpperCase();
  if (conversationType.includes("SMS")) return "SMS";

  try {
    const contact = await getContact(contactId);
    const hasInstagramId = !!(
      contact?.instagramId || contact?.instagram ||
      contact?.socialProfiles?.instagram || contact?.customField?.instagram_id
    );
    const hasFacebookId = !!(
      contact?.facebookId || contact?.facebook ||
      contact?.socialProfiles?.facebook || contact?.customField?.facebook_id
    );

    if (hasInstagramId) return "IG";
    if (hasFacebookId) return "FB";
  } catch (err) {
    console.warn("Error checking contact for type inference:", err.message);
  }

  const lastType = conversation.lastMessageType || conversation.type || "";
  if (!lastType || typeof lastType !== "string") {
    if (!COMPACT_MODE) console.warn("inferConversationMessageType: no lastMessageType on conversation, defaulting to SMS");
    return "SMS";
  }

  const t = lastType.toUpperCase();
  if (t.includes("INSTAGRAM")) return "IG";
  if (t.includes("FACEBOOK")) return "FB";
  if (t.includes("WHATSAPP")) return "WhatsApp";
  if (t.includes("GMB")) return "GMB";
  if (t.includes("WEBCHAT") || t.includes("LIVE_CHAT")) return "Live_Chat";
  if (t.includes("EMAIL")) return "Email";
  if (t.includes("SMS") || t.includes("PHONE") || t.includes("CALL") || t.includes("CUSTOM_SMS")) return "SMS";

  if (!COMPACT_MODE) console.warn(`inferConversationMessageType: unrecognized lastMessageType=${lastType}, defaulting to FB`);
  return "FB";
}

/**
 * Helper: send a message via SDK's conversations API
 * The SDK's sendANewMessage posts to POST /conversations/messages
 */
async function _sendMessage(payload) {
  // SDK's SendMessageBodyDto doesn't include userId/conversationId/locationId
  // but the underlying API accepts them. Pass them through.
  return ghlSdk.conversations.sendANewMessage(payload);
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

  const markedBody = body + AI_MESSAGE_MARKER;

  const {
    isDm = false,
    hasPhone = false,
    conversationId = null,
    phone = null,
  } = channelContext;

  if (!COMPACT_MODE) {
    console.log("✉️ sendConversationMessage context:", cleanLogObject({
      contactId, isDm, hasPhone, conversationId,
    }));
  }

  // ═══ TEMPORARY REASSIGNMENT WORKFLOW FOR AI BOT USERID ═══
  let originalAssignedTo = null;
  let needsReassignment = false;

  try {
    const contact = await getContact(contactId);
    originalAssignedTo = contact?.assignedTo;

    if (originalAssignedTo && originalAssignedTo !== AI_BOT_USER_ID) {
      needsReassignment = true;
      try {
        await temporaryReassignForAIMessage(contactId, originalAssignedTo);
      } catch (reassignErr) {
        console.error("⚠️ Failed to temporarily reassign to AI Bot:", reassignErr.message);
        console.warn("⚠️ Continuing anyway - message will not have AI Bot userId");
        needsReassignment = false;
      }
    }
  } catch (err) {
    console.error("⚠️ Error in reassignment workflow setup:", err.message);
  }

  // 1) DM reply path (no phone required)
  if (isDm) {
    let finalConversationId = conversationId;
    let dmType = null;
    let foundConversation = null;

    if (!finalConversationId) {
      if (!COMPACT_MODE) console.log("🔍 No conversationId provided for DM, searching for DM conversation...");

      foundConversation = await findConversationForContact(contactId, { typeFilter: "DM" });

      if (foundConversation) {
        finalConversationId = foundConversation.id || foundConversation._id;

        const lastType = (foundConversation.lastMessageType || foundConversation.type || "").toUpperCase();
        if (lastType.includes("INSTAGRAM") || lastType.includes("IG")) {
          dmType = "IG";
        } else if (lastType.includes("FACEBOOK") || lastType.includes("FB") || lastType.includes("MESSENGER")) {
          dmType = "FB";
        } else {
          dmType = await inferConversationMessageType(contactId, { preferDm: true });
        }
        if (!COMPACT_MODE) console.log(`✅ Found DM conversation ${finalConversationId} with type ${dmType}`);
      } else {
        if (!COMPACT_MODE) console.log("🔍 No existing DM conversation found, will try to infer type from contact...");
      }
    } else {
      dmType = await inferConversationMessageType(contactId, { preferDm: true });
    }

    if (finalConversationId && dmType && dmType !== "SMS") {
      const shouldValidateIds = !foundConversation;

      if (shouldValidateIds) {
        let contact = null;
        try {
          contact = await getContact(contactId);
        } catch (err) {
          console.error("❌ Error fetching contact for DM validation:", err.message);
          throw err;
        }

        const checkSocialIds = (contact) => {
          const hasInstagramId = !!(
            contact?.instagramId || contact?.instagram ||
            contact?.socialProfiles?.instagram || contact?.customField?.instagram_id
          );
          const hasFacebookId = !!(
            contact?.facebookId || contact?.facebook ||
            contact?.socialProfiles?.facebook || contact?.customField?.facebook_id
          );
          return { hasInstagramId, hasFacebookId };
        };

        if (dmType !== "IG" && dmType !== "FB") {
          const tags = contact?.tags || [];
          const hasInstagram = tags.some(t => String(t).toUpperCase().includes("INSTAGRAM"));
          const hasFacebook = tags.some(t => String(t).toUpperCase().includes("FACEBOOK"));

          const { hasInstagramId, hasFacebookId } = checkSocialIds(contact);

          if (hasInstagramId || (hasInstagram && !hasFacebookId)) {
            dmType = "IG";
          } else if (hasFacebookId || hasFacebook) {
            dmType = "FB";
          } else {
            dmType = "FB";
          }
        }

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
        if (!COMPACT_MODE) console.log(`✅ Using conversation type ${dmType} from GHL conversation - skipping ID validation`);
      }

      try {
        const payload = {
          conversationId: finalConversationId,
          contactId,
          message: markedBody,
          type: dmType,
          userId: AI_BOT_USER_ID,
        };

        if (!COMPACT_MODE) console.log("📨 Sending DM reply via GHL:", payload);

        const result = await _sendMessage(payload);

        if (!COMPACT_MODE) console.log("📨 GHL DM reply response:", { contactId, conversationId: finalConversationId });

        if (needsReassignment && originalAssignedTo) {
          await reassignToOriginalArtist(contactId, originalAssignedTo);
        }

        return result;
      } catch (err) {
        console.error("❌ Error sending DM reply via GHL:", err.response?.data || err.message);

        if (needsReassignment && originalAssignedTo) {
          await reassignToOriginalArtist(contactId, originalAssignedTo);
        }

        // fall through to try alternative method
      }
    }

    if (!finalConversationId) {
      try {
        const inferredType = await inferConversationMessageType(contactId, { preferDm: true });

        if (inferredType === "IG" || inferredType === "FB") {
          const payload = {
            contactId,
            locationId: GHL_LOCATION_ID,
            message: markedBody,
            type: inferredType,
            userId: AI_BOT_USER_ID,
          };

          if (!COMPACT_MODE) console.log("📨 Sending DM via GHL (creating new conversation):", payload);

          const result = await _sendMessage(payload);

          if (!COMPACT_MODE) console.log("📨 GHL DM message response (new conversation):", { contactId, type: inferredType });

          if (needsReassignment && originalAssignedTo) {
            await reassignToOriginalArtist(contactId, originalAssignedTo);
          }

          return result;
        } else {
          console.warn(`⚠️ Cannot send DM: inferred type is ${inferredType}, not IG/FB`);

          if (needsReassignment && originalAssignedTo) {
            await reassignToOriginalArtist(contactId, originalAssignedTo);
          }
        }
      } catch (err) {
        console.error("❌ Error sending DM via GHL (new conversation):", err.response?.data || err.message);

        if (needsReassignment && originalAssignedTo) {
          await reassignToOriginalArtist(contactId, originalAssignedTo);
        }
      }
    }
  }

  // 2) SMS / phone-based path
  if (hasPhone && phone) {
    try {
      const { isWhatsApp = false } = channelContext;
      const type = isWhatsApp ? "WhatsApp" : "SMS";

      const payload = {
        contactId,
        locationId: GHL_LOCATION_ID,
        message: markedBody,
        type,
        userId: AI_BOT_USER_ID,
      };

      const result = await _sendMessage(payload);

      if (!COMPACT_MODE) console.log("📨 GHL conversations API response:", { contactId, type });

      if (needsReassignment && originalAssignedTo) {
        await reassignToOriginalArtist(contactId, originalAssignedTo);
      }

      return result;
    } catch (err) {
      console.error("❌ Error sending SMS/phone message via GHL:", err.response?.data || err.message);

      if (needsReassignment && originalAssignedTo) {
        await reassignToOriginalArtist(contactId, originalAssignedTo);
      }

      throw err;
    }
  } else {
    // Fallback
    if (!isDm) {
      try {
        let type = await inferConversationMessageType(contactId);

        if (type === "WhatsApp") {
          const contact = await getContact(contactId);
          const cf = contact?.customField || contact?.customFields || {};
          const whatsappUser = cf.whatsapp_user || cf.whatsappUser || cf.FnYDobmYqnXDxlLJY5oe || "";
          const hasWhatsAppEnabled = whatsappUser.toLowerCase() === "yes";
          const phone = contact?.phone || contact?.phoneNumber;
          const isUSPhone = isUSPhoneNumber(phone);

          if (!hasWhatsAppEnabled || isUSPhone) {
            console.warn(`⚠️ [CHANNEL] Inferred WhatsApp but contact ${contactId} ${!hasWhatsAppEnabled ? "doesn't have WhatsApp enabled" : "has a US phone number"} - falling back to SMS`);
            type = "SMS";
          }
        }

        const payload = {
          contactId,
          locationId: GHL_LOCATION_ID,
          message: markedBody,
          type,
          userId: AI_BOT_USER_ID,
        };

        const result = await _sendMessage(payload);

        if (!COMPACT_MODE) console.log("📨 GHL conversations API response (fallback):", { contactId, type });

        return result;
      } catch (err) {
        console.error("❌ Error sending message via GHL (fallback):", err.response?.data || err.message);
        throw err;
      } finally {
        if (needsReassignment && originalAssignedTo) {
          await reassignToOriginalArtist(contactId, originalAssignedTo);
        }
      }
    } else {
      console.warn(
        "⚠️ No valid phone number and no DM conversationId; cannot send message.",
        { contactId, isDm, hasPhone, conversationId }
      );

      if (needsReassignment && originalAssignedTo) {
        await reassignToOriginalArtist(contactId, originalAssignedTo);
      }

      return null;
    }
  }
}

// ============================================================================
// V2 API Functions for Contact Assignment and Followers
// ============================================================================

const MESSAGE_CONSULT_ARTIST_ID = "y0BeYjuRIlDwsDcOHOJo";
const TRANSLATOR_FOLLOWER_ID = "sx6wyHhbFdRXh302Lunr";

/**
 * Assign an artist to a contact using GHL v2 API.
 */
async function assignContactToArtist(contactId, assignedToId = MESSAGE_CONSULT_ARTIST_ID) {
  if (!contactId) {
    console.warn("assignContactToArtist called without contactId");
    return null;
  }
  if (!assignedToId) {
    console.warn("assignContactToArtist called without assignedToId");
    return null;
  }

  try {
    const result = await ghlSdk.contacts.updateContact(
      { contactId },
      { assignedTo: assignedToId }
    );

    console.log("✅ Assigned artist to contact", {
      contactId,
      assignedTo: assignedToId,
    });

    return result;
  } catch (err) {
    console.error(
      "❌ Error assigning artist to contact:",
      err.response?.status || err.statusCode,
      err.response?.data || err.message
    );
    return null;
  }
}

/**
 * Add followers to a contact using GHL v2 API.
 */
async function addFollowersToContact(contactId, followerIds) {
  if (!contactId) {
    console.warn("addFollowersToContact called without contactId");
    return null;
  }

  const followers = Array.isArray(followerIds) ? followerIds : [followerIds];

  if (followers.length === 0 || !followers[0]) {
    console.warn("addFollowersToContact called without valid followerIds");
    return null;
  }

  try {
    const result = await ghlSdk.contacts.addFollowersContact(
      { contactId },
      { followers }
    );

    console.log("✅ Added followers to contact", {
      contactId,
      followers,
    });

    return result;
  } catch (err) {
    console.error(
      "❌ Error adding followers to contact:",
      err.response?.status || err.statusCode,
      err.response?.data || err.message
    );
    return null;
  }
}

/**
 * Add translator as follower to a contact.
 */
async function addTranslatorAsFollower(contactId) {
  console.log(`🌐 Adding translator as follower for contact ${contactId}`);
  return addFollowersToContact(contactId, TRANSLATOR_FOLLOWER_ID);
}

module.exports = {
  getContact,
  getContactV2,
  createContact,
  updateContact,
  lookupContactIdByEmailOrPhone,
  upsertContactFromWidget,
  updateSystemFields,
  updateTattooFields,
  uploadFilesToTattooCustomField,
  sendConversationMessage,
  findConversationForContact,
  inferConversationMessageType,
  updateContactAssignedUser,
  createTaskForContact,
  getConversationHistory,
  assignContactToArtist,
  addFollowersToContact,
  addTranslatorAsFollower,
  temporaryReassignForAIMessage,
  reassignToOriginalArtist,
  isUSPhoneNumber,
  mapCustomFields,
  normalizeTags,
  // Constants for external use
  MESSAGE_CONSULT_ARTIST_ID,
  TRANSLATOR_FOLLOWER_ID,
};
