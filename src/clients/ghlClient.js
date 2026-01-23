require("dotenv").config();

// ghlClient.js
const axios = require("axios");
const FormData = require("form-data");
const { cleanLogObject, COMPACT_MODE, shortId } = require("../utils/logger");
const { SYSTEM_FIELDS } = require("../config/constants");

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_FILE_UPLOAD_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN;

// AI message marker: double-space appended to AI-sent messages
// iOS app uses this to detect and display "AI Response ✓" indicator
// Using double-space instead of zero-width space to avoid UCS-2 encoding (which doubles SMS costs)
const AI_MESSAGE_MARKER = "  ";

// Axios client for GHL v1 API
const ghl = axios.create({
  baseURL: "https://rest.gohighlevel.com", // v1 base
  headers: {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
  },
});

// 🔹 Map widget custom field keys -> actual GHL custom field IDs
// These are the actual GHL field IDs from the contact API
const CUSTOM_FIELD_MAP = {
  language_preference: "ETxasC6QlyxRaKU18kbz",
  inquired_technician: "H3PSN8tZSw1kYckHJN9D",
  whatsapp_user: "FnYDobmYqnXDxlLJY5oe",
  tattoo_title: "8JqgdVJraABsqgUeqJ3a", // "Lower forearm vine warp. Fillers for patch half"
  tattoo_summary: "xAGtMfmbxtfCHdo2oyf7", // "Realistic vine with "
  tattoo_placement: "jd8YhvKsBi4aGqjqOEOv",
  tattoo_style: "12b2O4ydlfO99FA4yCuk",
  // Canonical CRM key (was size_of_tattoo historically)
  tattoo_size: "KXtfZYdeSKUyS5llTKsr",
  tattoo_color_preference: "SzyropMDMcitUDhhb8dd",
  how_soon_is_client_deciding: "ra4Nk80WMA8EQkLCfXST",
  first_tattoo: "QqDydmY1fnldidlcMnBC",
  tattoo_concerns: "tattoo_concerns", // TODO: Get actual ID if this field exists
  tattoo_photo_description: "ptrJy8TBBjlnRWQepdnP",
};

// 🔹 Reverse mapping: GHL field ID -> friendly name (for reading from GHL)
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
 * Create a task on a contact using GHL v2 API
 * @param {string} contactId
 * @param {object} task
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
    completed: task.completed !== undefined ? task.completed : false, // v2 uses boolean "completed" instead of "status"
    assignedTo: task.assignedTo || null,
  };

  // Use v2 API endpoint
  const url = `https://services.leadconnectorhq.com/contacts/${contactId}/tasks`;
  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Version: "2021-07-28", // Required for v2 API
    },
  });
  
  return res.data;
}

/**
 * Update the CRM owner (assigned user) for a contact.
 * Used when we decide which artist owns the lead.
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
      err.response?.status,
      err.response?.data || err.message
    );
    return null;
  }
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
 * @param {object} fields - keys like "tattoo_placement", "tattoo_size", etc.
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

// Search for conversations for a contact
// Options:
//   preferDm: boolean - if true, prioritize FB/IG conversations over SMS
//   typeFilter: "DM" | "SMS" | null - filter by conversation type
async function findConversationForContact(contactId, { preferDm = false, typeFilter = null } = {}) {
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

    // Helper to check if a conversation is a DM (FB/IG)
    const isDmConversation = (conv) => {
      const type = (conv.type || conv.lastMessageType || "").toUpperCase();
      return type.includes("FACEBOOK") || type.includes("FB") || 
             type.includes("INSTAGRAM") || type.includes("IG") ||
             type.includes("MESSENGER");
    };

    // Helper to check if a conversation is SMS
    const isSmsConversation = (conv) => {
      const type = (conv.type || conv.lastMessageType || "").toUpperCase();
      return type.includes("SMS");
    };

    // If a specific type filter is requested
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

    // If preferDm is true, try to find a DM conversation first
    if (preferDm) {
      const dmConv = convs.find(isDmConversation);
      if (dmConv) {
        if (!COMPACT_MODE) console.log(`🔍 Preferring DM conversation: ${dmConv.id} (type: ${dmConv.type || dmConv.lastMessageType})`);
        return dmConv;
      }
      // Fall back to most recent if no DM found
      if (!COMPACT_MODE) console.log("🔍 No DM conversation found, falling back to most recent");
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

/**
 * Fetch conversation history for a contact from GHL
 * Uses the /conversations/messages/export endpoint
 * 
 * @param {string} contactId - The contact's ID
 * @param {object} options - Query options
 * @param {number} options.limit - Number of messages to fetch (default 50, max 500)
 * @param {string} options.channel - Filter by channel: "SMS", "Instagram", "Facebook", "WhatsApp", "Email"
 * @param {string} options.sortOrder - "desc" (newest first) or "asc" (oldest first)
 * @returns {Promise<Array>} Array of messages with direction, body, attachments, dateAdded, source
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
    limit: String(Math.min(limit, 500)), // Cap at 500 (API max)
    sortBy: "createdAt",
    sortOrder,
  });

  // Only add channel filter if specified
  // When null, API returns all non-email messages including activity messages
  if (channel) {
    params.append("channel", channel);
  }

  const url = `https://services.leadconnectorhq.com/conversations/messages/export?${params}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
        Accept: "application/json",
        Version: "2021-04-15",
      },
    });

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

// Infer the outbound "type" for /conversations/messages by looking at the last inbound message
// Options:
//   preferDm: boolean - if true, prioritize FB/IG over SMS when checking contact
async function inferConversationMessageType(contactId, { preferDm = false } = {}) {
  if (!contactId) return "SMS";

  // If preferDm, check contact's social IDs first before looking at conversations
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
      
      // Check tags for DM indicators
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

  // Try to find a DM conversation first if preferDm
  const searchOptions = preferDm ? { typeFilter: "DM" } : {};
  const conversation = await findConversationForContact(contactId, searchOptions);
  
  if (!conversation) {
    // If preferDm and no DM conversation found, still check contact for social IDs
    if (preferDm) {
      if (!COMPACT_MODE) console.warn("inferConversationMessageType: no DM conversation found, checking contact tags...");
      try {
        const contact = await getContact(contactId);
        const tags = contact?.tags || [];
        const tagsLower = Array.isArray(tags) ? tags.map(t => String(t).toLowerCase()) : [];
        
        if (tagsLower.some(t => t.includes("instagram") || t.includes("ig"))) {
          return "IG";
        }
        if (tagsLower.some(t => t.includes("facebook") || t.includes("fb") || t.includes("messenger") || t.includes("dm"))) {
          return "FB";
        }
      } catch (err) {
        console.warn("Error checking contact tags:", err.message);
      }
    }
    if (!COMPACT_MODE) console.warn("inferConversationMessageType: no conversations found, defaulting to SMS");
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
    if (!COMPACT_MODE) console.warn("inferConversationMessageType: no lastMessageType on conversation, defaulting to SMS");
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
  if (!COMPACT_MODE) console.warn(`inferConversationMessageType: unrecognized lastMessageType=${lastType}, defaulting to FB`);
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

  // Append AI marker (zero-width space) to all AI-sent messages
  // iOS app detects this to show "AI Response ✓" indicator
  const markedBody = body + AI_MESSAGE_MARKER;

  const {
    isDm = false,
    hasPhone = false,
    conversationId = null,
    phone = null,
  } = channelContext;

  if (!COMPACT_MODE) {
    console.log("✉️ sendConversationMessage context:", cleanLogObject({
      contactId,
      isDm,
      hasPhone,
      conversationId,
    }));
  }

  // 1) DM reply path (no phone required)
  if (isDm) {
    // If no conversationId provided, try to find existing DM conversation
    let finalConversationId = conversationId;
    let dmType = null;

    let foundConversation = null;
    if (!finalConversationId) {
      if (!COMPACT_MODE) console.log("🔍 No conversationId provided for DM, searching for DM conversation...");
      
      // Specifically search for a DM conversation (FB/IG), not SMS
      foundConversation = await findConversationForContact(contactId, { typeFilter: "DM" });
      
      if (foundConversation) {
        finalConversationId = foundConversation.id || foundConversation._id;
        
        // Infer type from the conversation
        const lastType = (foundConversation.lastMessageType || foundConversation.type || "").toUpperCase();
        if (lastType.includes("INSTAGRAM") || lastType.includes("IG")) {
          dmType = "IG";
        } else if (lastType.includes("FACEBOOK") || lastType.includes("FB") || lastType.includes("MESSENGER")) {
          dmType = "FB";
        } else {
          // Fall back to inference function if conversation type is unclear (prefer DM since isDm=true)
          dmType = await inferConversationMessageType(contactId, { preferDm: true });
        }
        if (!COMPACT_MODE) console.log(`✅ Found DM conversation ${finalConversationId} with type ${dmType}`);
      } else {
        if (!COMPACT_MODE) console.log("🔍 No existing DM conversation found, will try to infer type from contact...");
      }
    } else {
      // If conversationId was provided, still infer the type (prefer DM since isDm=true)
      dmType = await inferConversationMessageType(contactId, { preferDm: true });
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
        if (!COMPACT_MODE) console.log(`✅ Using conversation type ${dmType} from GHL conversation - skipping ID validation`);
      }

      try {
        const payload = {
          conversationId: finalConversationId,
          contactId,
          message: markedBody,
          type: dmType, // Use inferred type (IG or FB)
        };

        if (!COMPACT_MODE) console.log("📨 Sending DM reply via GHL:", payload);

        const url = "https://services.leadconnectorhq.com/conversations/messages";
        const resp = await axios.post(url, payload, {
          headers: {
            Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            Version: "2021-07-28",
          },
        });

        if (!COMPACT_MODE) console.log("📨 GHL DM reply response:", { status: resp.status, contactId, conversationId: finalConversationId });

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
        // Infer DM type from contact tags or default to IG/FB (prefer DM since isDm=true)
        const inferredType = await inferConversationMessageType(contactId, { preferDm: true });
        
        // Only proceed if it's a social media type
        if (inferredType === "IG" || inferredType === "FB") {
          const payload = {
            contactId,
            locationId: GHL_LOCATION_ID,
            message: markedBody,
            type: inferredType,
          };

          if (!COMPACT_MODE) console.log("📨 Sending DM via GHL (creating new conversation):", payload);

          const url = "https://services.leadconnectorhq.com/conversations/messages";
          const resp = await axios.post(url, payload, {
            headers: {
              Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
              "Content-Type": "application/json",
              Accept: "application/json",
              Version: "2021-07-28",
            },
          });

          if (!COMPACT_MODE) console.log("📨 GHL DM message response (new conversation):", { status: resp.status, contactId, type: inferredType });

          return resp.data;
        } else {
          console.warn(`⚠️ Cannot send DM: inferred type is ${inferredType}, not IG/FB`);
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
      // Check if contact prefers WhatsApp, otherwise use SMS
      // Don't infer type here - inference is for DM conversations
      const { isWhatsApp = false } = channelContext;
      const type = isWhatsApp ? "WhatsApp" : "SMS";

      const payload = {
        contactId,
        locationId: GHL_LOCATION_ID,
        message: markedBody,
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

      if (!COMPACT_MODE) console.log("📨 GHL conversations API response:", { status: resp.status, contactId, type });

      return resp.data;
    } catch (err) {
      console.error("❌ Error sending SMS/phone message via GHL:", err.response?.data || err.message);
      throw err;
    }
  } else {
    // Fallback: try to infer type and send anyway (existing behavior for backward compatibility)
    if (!isDm) {
      try {
        let type = await inferConversationMessageType(contactId);

        // SAFETY CHECK: If inferred type is WhatsApp, verify contact actually has WhatsApp enabled
        // This prevents sending WhatsApp messages to contacts who don't have it,
        // which can happen if a previous message was incorrectly sent via WhatsApp
        if (type === "WhatsApp") {
          const contact = await getContact(contactId);
          const cf = contact?.customField || contact?.customFields || {};
          const whatsappUser = cf.whatsapp_user || cf.whatsappUser || cf.FnYDobmYqnXDxlLJY5oe || "";
          const hasWhatsAppEnabled = whatsappUser.toLowerCase() === "yes";

          if (!hasWhatsAppEnabled) {
            console.warn(`⚠️ [CHANNEL] Inferred WhatsApp but contact ${contactId} doesn't have WhatsApp enabled - falling back to SMS`);
            type = "SMS";
          }
        }

        const payload = {
          contactId,
          locationId: GHL_LOCATION_ID,
          message: markedBody,
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

        if (!COMPACT_MODE) console.log("📨 GHL conversations API response (fallback):", {
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






// ============================================================================
// V2 API Functions for Contact Assignment and Followers
// ============================================================================

// Artist ID for message-based consultations (assigned after deposit paid)
const MESSAGE_CONSULT_ARTIST_ID = "y0BeYjuRIlDwsDcOHOJo";

// Translator ID for video call consultations (added as follower)
const TRANSLATOR_FOLLOWER_ID = "sx6wyHhbFdRXh302Lunr";

/**
 * Assign an artist to a contact using GHL v2 API.
 * Used specifically when lead chooses message-based consultation and deposit is paid.
 * 
 * @param {string} contactId - The contact ID to assign
 * @param {string} assignedToId - The user ID to assign (defaults to MESSAGE_CONSULT_ARTIST_ID)
 * @returns {Promise<object|null>} The API response or null on error
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
    const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
    const payload = {
      assignedTo: assignedToId,
    };

    const resp = await axios.put(url, payload, {
      headers: {
        Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Version: "2021-07-28", // Required for GHL v2 API
      },
    });

    console.log("✅ Assigned artist to contact", {
      contactId,
      assignedTo: assignedToId,
      status: resp.status,
    });

    return resp.data;
  } catch (err) {
    console.error(
      "❌ Error assigning artist to contact:",
      err.response?.status,
      err.response?.data || err.message
    );
    return null;
  }
}

/**
 * Add followers to a contact using GHL v2 API.
 * Used to add translator as follower for video call consultations.
 * 
 * @param {string} contactId - The contact ID
 * @param {string|string[]} followerIds - Single follower ID or array of follower IDs
 * @returns {Promise<object|null>} The API response or null on error
 */
async function addFollowersToContact(contactId, followerIds) {
  if (!contactId) {
    console.warn("addFollowersToContact called without contactId");
    return null;
  }

  // Normalize to array
  const followers = Array.isArray(followerIds) ? followerIds : [followerIds];
  
  if (followers.length === 0 || !followers[0]) {
    console.warn("addFollowersToContact called without valid followerIds");
    return null;
  }

  try {
    const url = `https://services.leadconnectorhq.com/contacts/${contactId}/followers`;
    const payload = {
      followers: followers,
    };

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Version: "2021-07-28", // Required for GHL v2 API
      },
    });

    console.log("✅ Added followers to contact", {
      contactId,
      followers: followers,
      status: resp.status,
    });

    return resp.data;
  } catch (err) {
    console.error(
      "❌ Error adding followers to contact:",
      err.response?.status,
      err.response?.data || err.message
    );
    return null;
  }
}

/**
 * Add translator as follower to a contact.
 * Convenience wrapper for adding the default translator follower.
 * 
 * @param {string} contactId - The contact ID
 * @returns {Promise<object|null>} The API response or null on error
 */
async function addTranslatorAsFollower(contactId) {
  console.log(`🌐 Adding translator as follower for contact ${contactId}`);
  return addFollowersToContact(contactId, TRANSLATOR_FOLLOWER_ID);
}

module.exports = {
  getContact,
  updateContact,
  upsertContactFromWidget,
  updateSystemFields,
  updateTattooFields,
  uploadFilesToTattooCustomField,
  sendConversationMessage,
  updateContactAssignedUser,
  createTaskForContact,
  getConversationHistory,
  // V2 API functions
  assignContactToArtist,
  addFollowersToContact,
  addTranslatorAsFollower,
  // Constants for external use
  MESSAGE_CONSULT_ARTIST_ID,
  TRANSLATOR_FOLLOWER_ID,
};

