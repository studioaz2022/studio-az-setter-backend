require("dotenv").config();

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
  sendConversationMessage,
} = require("./ghlClient");

const {
  decideLeadTemperature,
  initialPhaseForNewIntake,
  decidePhaseForMessage,
} = require("./src/ai/stateMachine");

const { generateOpenerForContact } = require("./src/ai/aiClient");
const { handleInboundMessage } = require("./src/ai/controller");

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


app.use(express.json());

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

  // If we don't already have a language preference and this looks like Spanish, set it
  if (!currentLanguage && looksLikeSpanish(messageText)) {
    console.log("🌐 Detected Spanish DM/SMS. Updating language_preference to Spanish...");

    try {
      await updateSystemFields(contactId, {
        language_preference: "Spanish",
      });
      console.log("✅ language_preference updated to Spanish for contact:", contactId);
    } catch (err) {
      console.error(
        "❌ Failed to update language_preference:",
        err.response?.data || err.message
      );
    }
  }

  const currentPhase =
    cf["ai_phase"] ||
    cf["aiPhase"] ||
    "";

  const leadTemperature =
    cf["lead_temperature"] ||
    cf["leadTemperature"] ||
    "cold";

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
      });

    const meta = aiResult?.meta || {};
    console.log("🧠 AI meta from response:", {
      aiPhaseFromAI: meta.aiPhase,
      leadTemperatureFromAI: meta.leadTemperature,
      wantsDepositLink: meta.wantsDepositLink,
      depositPushedThisTurn: meta.depositPushedThisTurn,
      mentionDecoyOffered: meta.mentionDecoyOffered,
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


// Webhook to receive payment events from Square
app.post("/square/webhook", (req, res) => {
  console.log("💳 SQUARE WEBHOOK HIT");

  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  // Later, we will verify the signature using SQUARE_WEBHOOK_SECRET
  // and update GHL when a deposit is paid.
  res.status(200).send("OK");
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
