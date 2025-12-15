const express = require("express");
const crypto = require("crypto");

const {
  getContact,
  updateSystemFields,
  createContact,
  updateContact,
  lookupContactIdByEmailOrPhone,
  sendConversationMessage,
  updateTattooFields,
} = require("../../ghlClient");
const { handleInboundMessage } = require("../ai/controller");
const { getContactIdFromOrder } = require("../payments/squareClient");
const {
  extractCustomFieldsFromPayload,
  buildEffectiveContact,
} = require("../ai/contextBuilder");

// Helper: Filter object to only show non-empty fields (for cleaner logs)
function filterNonEmpty(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const filtered = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    filtered[key] = value;
  }
  return filtered;
}

// Helper: Extract non-empty custom fields from contact
function getNonEmptyCustomFields(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  return filterNonEmpty(cf);
}

// Helper: Derive channel context from webhook payload and contact
function deriveChannelContext(payload, contact) {
  // Check if this is a DM based on attribution source medium
  const medium = (
    payload?.contact?.attributionSource?.medium ||
    payload?.contact?.lastAttributionSource?.medium ||
    ""
  ).toLowerCase();
  
  // Check tags for DM indicators
  const tagsRaw = payload?.tags || contact?.tags || [];
  const tags = Array.isArray(tagsRaw) ? tagsRaw : [tagsRaw];
  const tagsLower = tags.map(t => String(t).toLowerCase());
  
  const isDmFromMedium = medium === "facebook" || medium === "instagram" || medium === "fb" || medium === "ig";
  const isDmFromTags = tagsLower.some(t => 
    t.includes("dm") || 
    t.includes("instagram") || 
    t.includes("facebook") ||
    t.includes("messenger")
  );
  
  const isDm = isDmFromMedium || isDmFromTags;
  const hasPhone = !!(contact?.phone || contact?.phoneNumber || payload?.phone);
  
  return {
    isDm,
    hasPhone,
    conversationId: null,
    phone: contact?.phone || contact?.phoneNumber || payload?.phone || null,
  };
}

function createApp() {
  const app = express();

  // Use JSON body parsing for all routes except the Square webhook (raw body needed for signature)
  app.use((req, res, next) => {
    if (req.path === "/square/webhook") {
      return next();
    }
    return express.json({ limit: "1mb" })(req, res, next);
  });

  // Raw body for Square webhook verification
  app.use(
    "/square/webhook",
    express.raw({
      type: "*/*",
      limit: "1mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.post("/ghl/message-webhook", async (req, res) => {
    try {
      console.log("\n💬 ════════════════════════════════════════════════════════");
      console.log("💬 GHL MESSAGE WEBHOOK HIT");
      console.log("💬 ════════════════════════════════════════════════════════");

      const payload = req.body || {};
      const contactId =
        payload.contactId ||
        payload.contact_id ||
        payload.contact?.id ||
        payload.contact?.contactId ||
        null;
      
      // Extract message text - handle both string and object formats
      // GHL sends message as {type: 11, body: "..."} for DM messages
      const rawMessage = payload.message;
      const messageText =
        (typeof rawMessage === "object" && rawMessage?.body) ? rawMessage.body :
        (typeof rawMessage === "string") ? rawMessage :
        payload.text ||
        payload.customData?.messageBody ||
        (typeof payload.body === "string" ? payload.body : null) ||
        payload.body?.text ||
        payload.body?.message ||
        "";

      // Log non-empty payload fields
      const nonEmptyPayload = filterNonEmpty(payload);
      console.log("📦 Webhook Payload (non-empty fields):", JSON.stringify(nonEmptyPayload, null, 2));

      // Log the incoming message prominently
      console.log("📩 Incoming message text:", messageText || "(empty)");
      console.log("👤 Contact ID:", contactId);

      if (!contactId) {
        console.warn("⚠️ /ghl/message-webhook missing contactId");
        return res.status(200).json({ ok: false, error: "missing contactId" });
      }

      const contactRaw = await getContact(contactId);
      
      // Extract custom fields from webhook payload (more reliable than getContact array format)
      const webhookCustomFields = extractCustomFieldsFromPayload(payload);
      console.log("📋 Webhook custom fields extracted:", JSON.stringify(webhookCustomFields, null, 2));
      
      // Merge webhook custom fields into contact (webhook payload has correct format)
      const contact = buildEffectiveContact(contactRaw, webhookCustomFields);
      
      // Log contact info
      console.log("👤 Contact:", contact?.firstName || "(no first name)", contact?.lastName || "(no last name)");
      console.log("📋 Contact custom fields (merged):", JSON.stringify(getNonEmptyCustomFields(contact), null, 2));

      const result = await handleInboundMessage({
        contact,
        aiPhase: null,
        leadTemperature: null,
        latestMessageText: messageText,
        contactProfile: {},
        consultExplained: contact?.customField?.consult_explained || webhookCustomFields?.consult_explained,
      });

      // Log AI result summary
      console.log("🤖 AI Response Summary:", {
        bubblesCount: result?.aiResult?.bubbles?.length || 0,
        phase: result?.ai_phase,
        handler: result?.routing?.selected_handler,
        reason: result?.routing?.reason,
        fieldUpdatesKeys: Object.keys(result?.aiResult?.field_updates || {}),
      });

      // Derive channel context for message sending
      const channelContext = deriveChannelContext(payload, contact);
      console.log("📡 Channel context:", channelContext);

      // Send the AI's bubbles to the user
      const bubbles = result?.aiResult?.bubbles || [];
      let sentCount = 0;
      for (const bubble of bubbles) {
        if (bubble && bubble.trim()) {
          try {
            await sendConversationMessage({
              contactId,
              body: bubble,
              channelContext,
            });
            sentCount++;
          } catch (err) {
            console.error("❌ Failed to send bubble:", err.message || err);
          }
        }
      }
      console.log(`📤 Sent ${sentCount}/${bubbles.length} bubbles to GHL conversation`);

      // Persist the field updates from AI
      const fieldUpdates = result?.aiResult?.field_updates || {};
      if (Object.keys(fieldUpdates).length > 0 && contactId) {
        try {
          await updateTattooFields(contactId, fieldUpdates);
          console.log("✅ Persisted field_updates:", Object.keys(fieldUpdates));
        } catch (err) {
          console.error("❌ Failed to persist field_updates:", err.message || err);
        }
      } else {
        console.log("ℹ️ No field_updates from AI to persist this turn");
      }

      console.log("💬 ════════════════════════════════════════════════════════\n");
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ /ghl/message-webhook error:", err.message || err);
      return res.status(200).json({ ok: false });
    }
  });

  app.post("/ghl/form-webhook", async (req, res) => {
    try {
      console.log("\n📝 ════════════════════════════════════════════════════════");
      console.log("📝 GHL FORM WEBHOOK HIT");
      console.log("📝 ════════════════════════════════════════════════════════");

      const payload = req.body || {};
      const {
        contactId: bodyContactId,
        contact_id: legacyContactId,
        firstName,
        lastName,
        email,
        phone,
        message,
        notes,
      } = payload;

      // Log non-empty payload fields
      const nonEmptyPayload = filterNonEmpty(payload);
      console.log("📦 Form Payload (non-empty fields):", JSON.stringify(nonEmptyPayload, null, 2));

      let contactId =
        bodyContactId || legacyContactId || payload.contact?.id || null;

      if (!contactId) {
        console.log("🔍 No contactId in payload, looking up by email/phone...");
        contactId = await lookupContactIdByEmailOrPhone(email, phone);
      }

      if (!contactId) {
        console.log("🆕 Creating new contact...");
        const created = await createContact({
          firstName,
          lastName,
          email,
          phone,
        });
        contactId =
          created?.id || created?._id || created?.contact?.id || created?.contact?._id || null;
        console.log("🆕 Created new contact:", contactId);
      } else {
        console.log("🔄 Updating existing contact:", contactId);
        await updateContact(contactId, {
          firstName,
          lastName,
          email,
          phone,
        });
      }

      const contact = contactId ? await getContact(contactId) : null;

      // Log contact info
      console.log("👤 Contact:", contact?.firstName || "(no first name)", contact?.lastName || "(no last name)");
      console.log("👤 Contact ID:", contactId);

      if (contact) {
        const webhookCustomFields = extractCustomFieldsFromPayload(payload);
        const effectiveContact = buildEffectiveContact(contact, webhookCustomFields);
        const syntheticText = message || notes || "New form submission";
        console.log("📩 Form message/notes:", syntheticText);
        console.log("📋 Contact custom fields (non-empty):", JSON.stringify(getNonEmptyCustomFields(effectiveContact), null, 2));

        const result = await handleInboundMessage({
          contact: effectiveContact,
          aiPhase: null,
          leadTemperature: null,
          latestMessageText: syntheticText,
          contactProfile: {},
          consultExplained: effectiveContact?.customField?.consult_explained || webhookCustomFields?.consult_explained,
        });

        // Log AI result summary
        console.log("🤖 AI Response Summary:", {
          bubblesCount: result?.aiResult?.bubbles?.length || 0,
          phase: result?.ai_phase,
          handler: result?.routing?.selected_handler,
          reason: result?.routing?.reason,
          fieldUpdatesKeys: Object.keys(result?.aiResult?.field_updates || {}),
        });

        // Derive channel context for message sending
        const channelContext = deriveChannelContext(payload, effectiveContact);
        console.log("📡 Channel context:", channelContext);

        // Send the AI's bubbles to the user
        const bubbles = result?.aiResult?.bubbles || [];
        let sentCount = 0;
        for (const bubble of bubbles) {
          if (bubble && bubble.trim()) {
            try {
              await sendConversationMessage({
                contactId,
                body: bubble,
                channelContext,
              });
              sentCount++;
            } catch (err) {
              console.error("❌ Failed to send bubble:", err.message || err);
            }
          }
        }
        console.log(`📤 Sent ${sentCount}/${bubbles.length} bubbles to GHL conversation`);

        // Persist the field updates from AI
        const fieldUpdates = result?.aiResult?.field_updates || {};
        if (Object.keys(fieldUpdates).length > 0 && contactId) {
          try {
            await updateTattooFields(contactId, fieldUpdates);
            console.log("✅ Persisted field_updates:", Object.keys(fieldUpdates));
          } catch (err) {
            console.error("❌ Failed to persist field_updates:", err.message || err);
          }
        } else {
          console.log("ℹ️ No field_updates from AI to persist this turn");
        }
      } else {
        console.warn("⚠️ No contact found/created, skipping AI processing");
      }

      console.log("📝 ════════════════════════════════════════════════════════\n");
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ /ghl/form-webhook error:", err.message || err);
      return res.status(200).json({ ok: false });
    }
  });

  app.post("/square/webhook", async (req, res) => {
    const secret = process.env.SQUARE_WEBHOOK_SECRET;
    const signature = req.get("x-square-signature") || "";

    if (!secret) {
      console.warn("⚠️ Missing SQUARE_WEBHOOK_SECRET");
      return res.status(401).send("missing secret");
    }

    const raw = req.rawBody || Buffer.from("");
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");

    if (signature !== expected) {
      return res.status(401).send("invalid signature");
    }

    let payload = {};
    try {
      payload = JSON.parse(raw.toString() || "{}");
    } catch (err) {
      console.error("❌ /square/webhook invalid JSON:", err.message || err);
      return res.status(400).send("invalid json");
    }

    try {
      const payment = payload?.data?.object?.payment || {};
      const orderId = payment.order_id || payment.orderId || null;
      let contactId = payment.reference_id || payment.referenceId || null;

      if (!contactId && orderId) {
        contactId = await getContactIdFromOrder(orderId);
      }

      if (contactId) {
        await updateSystemFields(contactId, {
          deposit_paid: true,
        });
      } else {
        console.warn("⚠️ /square/webhook could not resolve contactId from payment");
      }
    } catch (err) {
      console.error("❌ /square/webhook processing error:", err.message || err);
    }

    return res.status(200).json({ ok: true });
  });

  return app;
}

module.exports = { createApp };
