// ghlSdk.js — Shared GHL SDK singleton
// All GHL client files import from here instead of creating their own axios instances
require("dotenv").config();
const { HighLevel } = require("@gohighlevel/api-client");

const GHL_FILE_UPLOAD_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN;

if (!GHL_FILE_UPLOAD_TOKEN) {
  console.warn("[GHL SDK] GHL_FILE_UPLOAD_TOKEN is not set — SDK will not authenticate.");
}

const ghl = new HighLevel({
  privateIntegrationToken: GHL_FILE_UPLOAD_TOKEN,
});

module.exports = { ghl };
