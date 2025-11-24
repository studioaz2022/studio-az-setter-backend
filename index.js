// index.js
require("dotenv").config();

const express = require("express");
const app = express();

// This lets Express parse JSON bodies from GHL & Square
app.use(express.json());

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Setter server listening on port ${PORT}`);
});
