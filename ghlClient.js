require("dotenv").config();

// ghlClient.js
const axios = require("axios");
const FormData = require("form-data");

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_TATTOO_FILE_FIELD_ID = process.env.GHL_TATTOO_FILE_FIELD_ID;

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
  deposit_link_sent: "deposit_link_sent",
  deposit_paid: "deposit_paid",
  last_phase_update_at: "last_phase_update_at",

  // 🔹 NEW: store the contact's preferred language
  language_preference: "language_preference", // make sure this matches the actual GHL key
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

// Send a message in a contact's conversation
async function sendConversationMessage({ contactId, body }) {
  if (!contactId) {
    throw new Error("contactId is required for sendConversationMessage");
  }
  if (!body || !body.trim()) {
    console.warn("sendConversationMessage called with empty body, skipping.");
    return null;
  }

  const payload = {
    contactId,
    locationId: GHL_LOCATION_ID,
    body, // message text
  };

  const url = "https://services.leadconnectorhq.com/conversations/messages";

  const resp = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Version: "2021-07-28", // required for this endpoint
    },
  });

  console.log("📨 GHL conversations API response:", {
    status: resp.status,
    contactId,
  });

  return resp.data;
}




module.exports = {
  getContact,
  upsertContactFromWidget,
  updateSystemFields,
  uploadFilesToTattooCustomField,
  sendConversationMessage,
};
