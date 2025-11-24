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

// Webhook to receive form submissions from GoHighLevel
app.post("/ghl/form-webhook", (req, res) => {
  console.log("📝 GHL FORM WEBHOOK HIT");

  // Full payload
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  // Always respond quickly so GHL doesn't think it failed
  res.status(200).send("OK");
});

// Webhook to receive conversation messages from GoHighLevel
app.post("/ghl/message-webhook", (req, res) => {
  console.log("💬 GHL MESSAGE WEBHOOK HIT");

  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  // In the future, we'll parse contactId, message text, etc.
  // For now we just log it.
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
