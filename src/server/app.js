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
      const payload = req.body || {};
      const contactId =
        payload.contactId ||
        payload.contact_id ||
        payload.contact?.id ||
        payload.contact?.contactId ||
        null;
      const messageText =
        payload.message ||
        payload.text ||
        payload.body ||
        payload.body?.text ||
        payload.body?.message ||
        "";

      if (!contactId) {
        console.warn("⚠️ /ghl/message-webhook missing contactId");
        return res.status(200).json({ ok: false, error: "missing contactId" });
      }

      const contact = await getContact(contactId);
      const result = await handleInboundMessage({
        contact,
        aiPhase: null,
        leadTemperature: null,
        latestMessageText: messageText,
        contactProfile: {},
        consultExplained: contact?.customField?.consult_explained,
      });

      // Send the AI's bubbles to the user
      const bubbles = result?.aiResult?.bubbles || [];
      for (const bubble of bubbles) {
        if (bubble && bubble.trim()) {
          try {
            await sendConversationMessage({
              contactId,
              body: bubble,
              channelContext: {},
            });
          } catch (err) {
            console.error("❌ Failed to send bubble:", err.message || err);
          }
        }
      }

      // Persist the field updates from AI
      const fieldUpdates = result?.aiResult?.field_updates || {};
      if (Object.keys(fieldUpdates).length > 0 && contactId) {
        try {
          await updateTattooFields(contactId, fieldUpdates);
        } catch (err) {
          console.error("❌ Failed to persist field_updates:", err.message || err);
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ /ghl/message-webhook error:", err.message || err);
      return res.status(200).json({ ok: false });
    }
  });

  app.post("/ghl/form-webhook", async (req, res) => {
    try {
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

      let contactId =
        bodyContactId || legacyContactId || payload.contact?.id || null;

      if (!contactId) {
        contactId = await lookupContactIdByEmailOrPhone(email, phone);
      }

      if (!contactId) {
        const created = await createContact({
          firstName,
          lastName,
          email,
          phone,
        });
        contactId =
          created?.id || created?._id || created?.contact?.id || created?.contact?._id || null;
      } else {
        await updateContact(contactId, {
          firstName,
          lastName,
          email,
          phone,
        });
      }

      const contact = contactId ? await getContact(contactId) : null;

      if (contact) {
        const syntheticText = message || notes || "New form submission";
        const result = await handleInboundMessage({
          contact,
          aiPhase: null,
          leadTemperature: null,
          latestMessageText: syntheticText,
          contactProfile: {},
          consultExplained: contact?.customField?.consult_explained,
        });

        // Send the AI's bubbles to the user
        const bubbles = result?.aiResult?.bubbles || [];
        for (const bubble of bubbles) {
          if (bubble && bubble.trim()) {
            try {
              await sendConversationMessage({
                contactId,
                body: bubble,
                channelContext: {},
              });
            } catch (err) {
              console.error("❌ Failed to send bubble:", err.message || err);
            }
          }
        }

        // Persist the field updates from AI
        const fieldUpdates = result?.aiResult?.field_updates || {};
        if (Object.keys(fieldUpdates).length > 0 && contactId) {
          try {
            await updateTattooFields(contactId, fieldUpdates);
          } catch (err) {
            console.error("❌ Failed to persist field_updates:", err.message || err);
          }
        }
      }

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
