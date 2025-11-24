require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { getContact, upsertContactFromWidget } = require("./ghlClient");
const app = express();

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

  // Safely grab contactId from the payload
  const customData = req.body.customData || req.body.custom_data || {};
  const contactId =
    customData.contactId ||
    req.body.contactId || // in case you ever send it top-level
    null;

  console.log("Parsed contactId from form webhook:", contactId);

  if (!contactId) {
    console.warn("⚠️ No contactId found in form webhook payload");
    return res.status(200).send("OK");
  }

  // Fetch contact from GHL
  const contact = await getContact(contactId);

  if (!contact) {
    console.warn("⚠️ Could not load contact from GHL for id:", contactId);
    return res.status(200).send("OK");
  }

  // Log a cleaner summary we’ll use later
  console.log("✅ Loaded Contact from GHL (form webhook):", {
    id: contact.id || contact._id,
    firstName: contact.firstName || contact.first_name,
    lastName: contact.lastName || contact.last_name,
    email: contact.email,
    phone: contact.phone,
    tags: contact.tags,
  });

  // In future: we’ll derive ai_phase & lead_temperature here.
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

  // Later we’ll also:
  // - Fetch the latest message text & attachments
  // - Decide ai_phase & lead_temperature
  // - Call the AI Setter
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
app.post("/lead/final", async (req, res) => {
  console.log("🔸 /lead/final hit");
  console.log("Payload:", JSON.stringify(req.body, null, 2));

  try {
    const { contactId, contact } = await upsertContactFromWidget(
      req.body,
      "final"
    );

    console.log("✅ Final upsert complete:", {
      contactId,
      firstName: contact?.firstName || contact?.first_name,
      lastName: contact?.lastName || contact?.last_name,
      email: contact?.email,
      phone: contact?.phone,
      tags: contact?.tags,
    });

    // IMPORTANT:
    // At this point, the contact *should* have the "consultation request" tag.
    // That will trigger your GHL Workflow 1 → which POSTs to /ghl/form-webhook.

    return res.json({
      ok: true,
      mode: "final",
      contactId,
    });
  } catch (err) {
    console.error(
      "❌ Error in /lead/final:",
      err.response?.status,
      err.response?.data || err.message
    );
    return res.status(500).json({
      ok: false,
      error: "Failed to upsert contact (final)",
    });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Setter server listening on port ${PORT}`);
});
