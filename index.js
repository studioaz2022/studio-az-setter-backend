require("dotenv").config();

const crypto = require("crypto");
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const express = require("express");
const cors = require("cors");

const {
  uploadFilesToTattooCustomField,
  getContact,
  upsertContactFromWidget,
  updateSystemFields,
  updateTattooFields,
  sendConversationMessage,
} = require("./ghlClient");

const {
  decideLeadTemperature,
  initialPhaseForNewIntake,
  decidePhaseForMessage,
} = require("./src/ai/stateMachine");

const { generateOpenerForContact } = require("./src/ai/aiClient");
const { handleInboundMessage } = require("./src/ai/controller");
const { createDepositLinkForContact, getContactIdFromOrder } = require("./src/payments/squareClient");

const app = express();

// 🔹 Simple heuristic to detect Spanish messages
function looksLikeSpanish(text) {
  if (!text) return false;
  const v = String(text).toLowerCase();

  const spanishHints = [
    "hola",
    "gracias",
    "buenos días",
    "buenas tardes",
    "buenas noches",
    "quiero",
    "podría",
    "me gustaría",
    "tatuaje",
    "tatuajes",
    "cita",
    "presupuesto",
    "antebrazo",
    "muñeca",
    "pierna",
    "dolor",
    "cotizar",
    "cotización",
    "cotices",
    "cotizo",
    "busco",
    "oye",
    "negro y gris",
    "en un mes",
  ];

  const hasAccent = /[áéíóúñ]/.test(v);

  let hits = 0;
  for (const word of spanishHints) {
    if (v.includes(word)) hits++;
  }

  // Accent OR at least 2 Spanish words = Spanish
  return hasAccent || hits >= 2;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateDelayForText(text) {
  const len = (text || "").length;

  // Delay rules (you can tune these later)
  if (len < 80) return 8000;     // ~8 seconds
  if (len < 160) return 12000;   // ~12 seconds
  return 18000;                  // ~18 seconds
}

// 🔐 Validate Square webhook signatures using x-square-hmacsha256-signature
function verifySquareSignatureSafe({ req, rawBody }) {
  try {
    const signatureHeader =
      req.headers["x-square-hmacsha256-signature"] ||
      req.headers["x-square-signature"];
    const signatureKey = process.env.SQUARE_WEBHOOK_SECRET;
    if (!signatureKey || !signatureHeader) {
      console.warn(
        "[Square] Missing SQUARE_WEBHOOK_SECRET or signature header; skipping strict verification."
      );
      return {
        isValid: false,
        expectedSignature: null,
        receivedSignature: signatureHeader || null,
      };
    }

    // IMPORTANT: Square spec: HMAC-SHA256 over (notificationUrl + rawBody)
    const notificationUrl =
      process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ||
      "https://studio-az-setter-backend.onrender.com/square/webhook";
    const hmac = crypto.createHmac("sha256", signatureKey);
    hmac.update(notificationUrl + rawBody);
    const expectedSignature = hmac.digest("base64");

    const isValid = expectedSignature === signatureHeader;

    return {
      isValid,
      expectedSignature,
      receivedSignature: signatureHeader,
    };
  } catch (err) {
    console.error("[Square] Error verifying webhook signature:", err);
    return {
      isValid: false,
      expectedSignature: null,
      receivedSignature: null,
    };
  }
}

app.post(
  "/square/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("📬 Square webhook received");

    try {
      const rawBody = req.body.toString("utf8");
      console.log("📬 Square Webhook Raw Body:\n", rawBody);

      const { isValid, expectedSignature, receivedSignature } =
        verifySquareSignatureSafe({ req, rawBody });

      if (!isValid) {
        console.warn(
          "⚠️ Square webhook signature did NOT validate. Continuing in sandbox mode.\n" +
            "Double-check that SQUARE_WEBHOOK_SECRET matches the 'Signature key' configured for this webhook subscription in the Square Dashboard."
        );
        if (expectedSignature && receivedSignature) {
          console.warn("Expected:", expectedSignature);
          console.warn("Received:", receivedSignature);
        }
      } else {
        console.log("✅ Square webhook signature validated.");
      }

      // Parse JSON AFTER signature check
      const event = JSON.parse(rawBody);
      console.log("📬 Parsed Square Event Type:", event.type);

      const eventType = event?.type;

      // We care primarily about payment events
      if (eventType === "payment.created" || eventType === "payment.updated") {
        const payment = event?.data?.object?.payment;
        if (!payment) {
          console.warn("⚠️ payment webhook without payment object");
        } else {
          const status = payment.status;
          const amount = payment.amount_money?.amount;
          const currency = payment.amount_money?.currency;
          const orderId = payment.order_id;

          console.log("💳 Payment details:", {
            paymentId: payment.id,
            status,
            amount,
            currency,
            orderId,
          });

          // Only act on completed/approved payments
          const normalizedStatus = (status || "").toUpperCase();
          const isDone =
            normalizedStatus === "COMPLETED" ||
            normalizedStatus === "APPROVED" ||
            normalizedStatus === "CAPTURED";

          if (isDone && orderId) {
            // Map order → GHL contactId via reference_id
            const contactId = await getContactIdFromOrder(orderId);

            if (!contactId) {
              console.warn(
                "⚠️ Could not resolve contactId from order; not updating GHL.",
                { orderId, paymentId: payment.id }
              );
            } else {
              console.log(`🎉 Deposit paid for contact ${contactId}`);

              // Mark deposit as paid in GHL system fields
              try {
                await updateSystemFields(contactId, {
                  deposit_paid: true,
                  deposit_link_sent: true,
                  last_phase_update_at: new Date().toISOString(),
                });
              } catch (ghlErr) {
                console.error("❌ Error updating GHL after deposit:", ghlErr.message || ghlErr);
              }

              // (Optional) Later we'll also move pipeline stage here once we have stage IDs nailed down.
              // e.g., await updatePipelineStage(contactId, "Deposit Paid");
            }
          } else {
            console.log(
              "ℹ️ Payment not in a completed/approved state yet; ignoring for now."
            );
          }
        }
      } else {
        // For now we just log other event types (order.updated, etc.)
        console.log("ℹ️ Non-payment webhook event received from Square.");
      }

      res.status(200).send("OK");
    } catch (err) {
      console.error("❌ Square Webhook error:", err);
      res.status(200).send("OK"); // still 200 to avoid retries while debugging
    }
  }
);

app.use(
  express.json({
    verify: (req, res, buf) => {
      // Save raw body for Square HMAC validation
      if (req.originalUrl === "/square/webhook") {
        req.rawBody = buf.toString("utf8");
      }
    },
  })
);

// 🔹 Allow your widget to call this API from the browser
app.use(
  cors({
    origin: "*", // for now allow all; we can tighten this later
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// (Optional but nice): log every request method + path
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Temporary test route (you can keep this)
app.get("/", (req, res) => {
  res.send("Studio AZ AI Setter backend is running");
});

// Webhook to receive form/intake events from GoHighLevel
app.post("/ghl/form-webhook", async (req, res) => {
  console.log("📝 GHL FORM WEBHOOK HIT");
  console.log("Raw Body:", JSON.stringify(req.body, null, 2));

  const customData = req.body.customData || req.body.custom_data || {};
  const contactId =
    customData.contactId ||
    req.body.contactId ||
    null;

  console.log("Parsed contactId from form webhook:", contactId);

  if (!contactId) {
    console.warn("⚠️ No contactId found in form webhook payload");
    return res.status(200).send("OK");
  }

  const contact = await getContact(contactId);

  if (!contact) {
    console.warn("⚠️ Could not load contact from GHL for id:", contactId);
    return res.status(200).send("OK");
  }

  console.log("✅ Loaded Contact from GHL (form webhook):", {
    id: contact.id || contact._id,
    firstName: contact.firstName || contact.first_name,
    lastName: contact.lastName || contact.last_name,
    email: contact.email,
    phone: contact.phone,
    tags: contact.tags,
  });

      // 🔹 Extract how_soon_is_client_deciding in a robust way
  const cfRaw = contact.customField || contact.customFields || {};
  console.log("Contact customField raw:", JSON.stringify(cfRaw, null, 2));

  let howSoonValue = null;

  // 1) Try from contact.customField (object or array)
  if (Array.isArray(cfRaw)) {
    const match = cfRaw.find(
      (f) =>
        f &&
        (
          f.key === "how_soon_is_client_deciding" ||
          f.id === "how_soon_is_client_deciding" ||
          f.customFieldId === "how_soon_is_client_deciding"
        )
    );
    howSoonValue = match?.value || null;
  } else {
    howSoonValue =
      cfRaw["how_soon_is_client_deciding"] ||
      cfRaw["howSoonIsClientDeciding"] ||
      null;
  }

  // 2) If still null, FALL BACK to the webhook body (what GHL just sent us)
  if (!howSoonValue) {
    const rawBody = req.body || {};
    // Your log shows "How Soon Is Client Deciding?" as the label
    for (const [key, value] of Object.entries(rawBody)) {
      if (
        typeof key === "string" &&
        key.toLowerCase().includes("how soon is client deciding")
      ) {
        howSoonValue = value;
        break;
      }
    }
  }

  const leadTemperature = decideLeadTemperature(howSoonValue);
  const aiPhase = initialPhaseForNewIntake();
  const nowIso = new Date().toISOString();

  console.log("🧠 Derived system state (form):", {
    leadTemperature,
    aiPhase,
    howSoonValue,
  });

  await updateSystemFields(contactId, {
    ai_phase: aiPhase,
    lead_temperature: leadTemperature,
    last_phase_update_at: nowIso,
  });

  console.log("✅ System fields updated for form webhook");

    // 🔹 Call AI Setter for Opener (log only for now)
  try {
    const aiResult = await generateOpenerForContact({
      contact,
      aiPhase,
      leadTemperature,
    });

    console.log("🤖 AI Opener suggestion:", JSON.stringify(aiResult, null, 2));

    // ⚠️ IMPORTANT:
    // Right now we are ONLY LOGGING the AI result.
    // In the next phase, we'll use this to send a real message back via GHL Conversations API.
  } catch (err) {
    console.error("❌ Error generating AI opener:", err.response?.data || err.message);
  }

  res.status(200).send("OK");
});


// Webhook to receive conversation messages from GoHighLevel
app.post("/ghl/message-webhook", async (req, res) => {
  console.log("💬 GHL MESSAGE WEBHOOK HIT");
  console.log("Raw Body:", JSON.stringify(req.body, null, 2));

  const customData = req.body.customData || req.body.custom_data || {};
  const contactId =
    customData.contactId ||
    req.body.contactId ||
    null;

  console.log("Parsed contactId from message webhook:", contactId);

  if (!contactId) {
    console.warn("⚠️ No contactId found in message webhook payload");
    return res.status(200).send("OK");
  }

  const contact = await getContact(contactId);

  if (!contact) {
    console.warn("⚠️ Could not load contact from GHL for id:", contactId);
    return res.status(200).send("OK");
  }

  console.log("✅ Loaded Contact from GHL (message webhook):", {
    id: contact.id || contact._id,
    firstName: contact.firstName || contact.first_name,
    lastName: contact.lastName || contact.last_name,
    email: contact.email,
    phone: contact.phone,
    tags: contact.tags,
  });

  const cf = contact.customField || contact.customFields || {};
  const currentLanguage =
    cf["language_preference"] ||
    cf["Language Preference"] ||
    null;

  // Extract the latest message text from the webhook payload
  // Try direct string fields first
    let messageText =
    req.body.messageBody ||
    req.body.body ||
    "";

    // If not found yet and there's a message object, use its body
    if (!messageText && req.body.message && typeof req.body.message.body === "string") {
    messageText = req.body.message.body;
    }

    // Also check inside customData if needed
    if (!messageText && typeof customData.messageBody === "string") {
    messageText = customData.messageBody;
    }
    if (!messageText && typeof customData.body === "string") {
    messageText = customData.body;
    }
    if (!messageText && customData.message && typeof customData.message.body === "string") {
    messageText = customData.message.body;
    }

    // Final safety cast
    messageText = String(messageText || "");

    console.log("📩 Incoming message text (for language detection):", messageText);

  // Detect language from message and update if different from existing preference
  const existingLanguagePreference = currentLanguage;

  let detectedLanguage = null;

  if (looksLikeSpanish(messageText)) {
    detectedLanguage = "Spanish";
  } else {
    // If it's not clearly Spanish, treat it as English by default
    detectedLanguage = "English";
  }

  if (
    detectedLanguage &&
    detectedLanguage !== existingLanguagePreference
  ) {
    console.log(
      "🌐 Updating language_preference based on DM/SMS detection:",
      {
        previous: existingLanguagePreference,
        next: detectedLanguage,
      }
    );

    try {
      await updateSystemFields(contactId, {
        language_preference: detectedLanguage,
      });
      console.log("✅ language_preference updated to", detectedLanguage, "for contact:", contactId);
    } catch (err) {
      console.error(
        "❌ Failed to update language_preference:",
        err.response?.data || err.message
      );
    }
  } else {
    console.log(
      "ℹ️ language_preference unchanged:",
      existingLanguagePreference || "(none)"
    );
  }

  const currentPhase =
    cf["ai_phase"] ||
    cf["aiPhase"] ||
    "";

  const leadTemperature =
    cf["lead_temperature"] ||
    cf["leadTemperature"] ||
    "warm";

  const newPhase = decidePhaseForMessage(currentPhase);
  const nowIso = new Date().toISOString();

  console.log("🧠 Derived system state (message):", {
    currentPhase,
    newPhase,
    leadTemperature,
  });

  await updateSystemFields(contactId, {
    ai_phase: newPhase,
    last_phase_update_at: nowIso,
  });

  console.log("✅ System fields updated for message webhook");

  // 🔄 Refetch contact so intake sees latest language_preference
  let freshContact = contact;
  try {
    const refreshed = await getContact(contactId);
    if (refreshed) {
      freshContact = refreshed;
      console.log("🔄 Refetched contact after system field update for AI call.");
    }
  } catch (err) {
    console.warn(
      "⚠️ Could not refresh contact before AI call, falling back to stale contact:",
      err.response?.data || err.message
    );
  }

  // 🔹 Call AI Setter and send reply into the conversation
  try {
    const { aiResult, ai_phase: newAiPhaseFromAI, lead_temperature: newLeadTempFromAI } =
      await handleInboundMessage({
        contact: freshContact,
        aiPhase: newPhase,
        leadTemperature,
        latestMessageText: messageText,
      });

    const meta = aiResult?.meta || {};
    const fieldUpdates = aiResult?.field_updates || {};

    console.log("🧠 AI DECISION SUMMARY", {
      aiPhaseFromAI: meta.aiPhase,
      leadTemperatureFromAI: meta.leadTemperature,
      wantsDepositLink: meta.wantsDepositLink,
      depositPushedThisTurn: meta.depositPushedThisTurn,
      mentionDecoyOffered: meta.mentionDecoyOffered,
      field_updates: fieldUpdates,
      bubblesPreview: Array.isArray(aiResult?.bubbles)
        ? aiResult.bubbles.map((b) => (b || "").slice(0, 80))
        : [],
    });

    console.log(
      "🤖 AI DM suggestion:",
      JSON.stringify(aiResult, null, 2)
    );

    if (aiResult && Array.isArray(aiResult.bubbles)) {
      const bubbles = aiResult.bubbles
        .map((b) => (b || "").trim())
        .filter(Boolean);

      if (bubbles.length === 0) {
        console.warn("⚠️ AI bubbles were empty after trimming, nothing sent.");
      } else {
        for (let i = 0; i < bubbles.length; i++) {
          const text = bubbles[i];

          // Only wait before bubble #2 and beyond (more human)
          if (i > 0) {
            const delayMs = calculateDelayForText(text);
            console.log(`⏱ Waiting ${delayMs}ms before sending bubble ${i + 1}...`);
            await sleep(delayMs);
          }

          await sendConversationMessage({
            contactId,
            body: text,
          });
        }
        console.log("📤 Sent delayed AI bubbles to GHL conversation.");

        // Update system fields from AI meta if present
        if (meta.aiPhase || meta.leadTemperature) {
          const updateFields = {};
          if (meta.aiPhase) updateFields.ai_phase = meta.aiPhase;
          if (meta.leadTemperature) updateFields.lead_temperature = meta.leadTemperature;
          updateFields.last_phase_update_at = new Date().toISOString();

          console.log("🧠 Updating contact system fields from AI meta:", {
            ai_phase: meta.aiPhase,
            lead_temperature: meta.leadTemperature,
          });

          await updateSystemFields(contactId, updateFields);
        }

        // Apply field_updates from AI response
        if (fieldUpdates && Object.keys(fieldUpdates).length > 0) {
          console.log("🧾 Applying AI field_updates to GHL:", fieldUpdates);
          try {
            await updateTattooFields(contactId, fieldUpdates);
          } catch (err) {
            console.error("❌ Failed to update tattoo-related fields from AI:", err.message);
          }
        } else {
          console.log("ℹ️ No field_updates from AI to apply this turn.");
        }

        // 💳 If the AI wants to send a deposit link, generate one
        if (aiResult?.meta?.wantsDepositLink === true) {
          console.log("💳 AI requested deposit link. Generating Square link...");

          try {
            const { url, paymentLinkId } = await createDepositLinkForContact({
              contactId,
              amountCents: 5000, // $50.00 example deposit — we can make this dynamic later
              description: "Studio AZ Tattoo Deposit",
            });

            if (!url) throw new Error("No URL returned");

            // Save square_reference_id + deposit_link_sent
            await updateTattooFields(contactId, {
              deposit_link_sent: "Yes",
              square_reference_id: paymentLinkId,
            });

            // Send link to client as another bubble
            await sendConversationMessage({
              contactId,
              body: `Here's your deposit link:\n${url}`,
            });

            console.log("💳 Deposit link delivered to lead");
          } catch (err) {
            console.error("❌ Failed to generate/send deposit link:", err);
          }
        }
      }
    } else {
      console.warn("⚠️ AI result did not contain bubbles array, nothing sent.");
    }
  } catch (err) {
    console.error(
      "❌ Error generating or sending AI DM suggestion:",
      err.response?.data || err.message || err
    );
  }

  res.status(200).send("OK");
});



// Test route to generate a Square sandbox deposit link
app.get("/payments/test-link", async (req, res) => {
  try {
    // If ?contactId=... is provided, we'll use it.
    // Otherwise we fall back to a fake test contact id.
    const contactId =
      req.query.contactId || `test-contact-${Date.now()}`;

    const { url, paymentLinkId } = await createDepositLinkForContact({
      contactId,
      amountCents: 5000, // $50.00 test deposit
      description: "Test Studio AZ Tattoo Deposit (Sandbox)",
    });

    if (!url) {
      return res
        .status(500)
        .json({ error: "No URL returned from createDepositLinkForContact" });
    }

    console.log("🧪 Test payment link created:", {
      contactId,
      url,
      paymentLinkId,
    });

    return res.json({
      message: "Sandbox test payment link created",
      contactId,
      paymentLinkId,
      url,
    });
  } catch (err) {
    console.error("❌ Error in /payments/test-link:", err);
    return res.status(500).json({
      error: "Failed to create test payment link",
      details: err.message,
    });
  }
});

// Create/update contact when the widget does the background "partial" save
app.post("/lead/partial", async (req, res) => {
  console.log("🔹 /lead/partial hit");
  console.log("Payload:", JSON.stringify(req.body, null, 2));

  try {
    const { contactId, contact } = await upsertContactFromWidget(
      req.body,
      "partial"
    );

    console.log("✅ Partial upsert complete:", {
      contactId,
      firstName: contact?.firstName || contact?.first_name,
      lastName: contact?.lastName || contact?.last_name,
      email: contact?.email,
      phone: contact?.phone,
      tags: contact?.tags,
    });

    return res.json({
      ok: true,
      mode: "partial",
      contactId,
    });
  } catch (err) {
    console.error(
      "❌ Error in /lead/partial:",
      err.response?.status,
      err.response?.data || err.message
    );
    return res.status(500).json({
      ok: false,
      error: "Failed to upsert contact (partial)",
    });
  }
});

// Create/update contact when the widget is fully submitted ("final" step)

app.post("/lead/final", upload.array("files"), async (req, res) => {
  console.log("🔸 /lead/final hit");
  console.log("Content-Type:", req.headers["content-type"]);

  const hasFiles = req.files && req.files.length > 0;
  console.log(
    "📎 Final lead files:",
    hasFiles ? req.files.map((f) => f.originalname) : "none"
  );

  let payload;

  try {
    if (req.is("multipart/form-data")) {
      // multipart: expect JSON string in req.body.data
      if (req.body && req.body.data) {
        payload = JSON.parse(req.body.data);
      } else {
        console.warn("⚠️ Multipart request but no req.body.data – using empty object");
        payload = {};
      }
    } else if (req.is("application/json")) {
      // pure JSON
      payload = req.body || {};
    } else {
      // fallback
      payload = req.body || {};
    }
  } catch (err) {
    console.error("❌ Failed to parse final lead payload:", err.message);
    return res.status(400).json({ ok: false, error: "Invalid payload" });
  }

  console.log("Payload (final lead):", JSON.stringify(payload, null, 2));

  // Safety: don't even hit GHL if we have no email/phone
  if (!payload.email && !payload.phone) {
    console.error("❌ Final lead missing email/phone");
    return res
      .status(400)
      .json({ ok: false, error: "Email or phone is required" });
  }

  try {
    // 1️⃣ Upsert contact with full info, ensure 'consultation request' tag, etc.
    const { contactId, contact } = await upsertContactFromWidget(payload, "final");

    console.log("✅ Final upsert complete:", {
      contactId,
      firstName: contact?.firstName || contact?.first_name,
      lastName: contact?.lastName || contact?.last_name,
      email: contact?.email,
      phone: contact?.phone,
    });

    // 2️⃣ Upload files to custom file field, if any
    if (hasFiles) {
      try {
        await uploadFilesToTattooCustomField(contactId, req.files);
      } catch (err) {
        console.error(
          "⚠️ Failed to upload files to GHL custom field:",
          err.response?.data || err.message
        );
      }
    }

    return res.json({ ok: true, contactId });
  } catch (err) {
    console.error(
      "❌ Error in /lead/final:",
      err.response?.data || err.message
    );
    return res
      .status(500)
      .json({ ok: false, error: "Failed to upsert contact (final)" });
  }
});




const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Setter server listening on port ${PORT}`);
});
