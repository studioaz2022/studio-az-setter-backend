require("dotenv").config();

const express = require("express");
const { getContact } = require("./ghlClient"); // 👈 new
const app = express();

app.use(express.json());
const axios = require("axios");

// Base URL & headers for GHL API (v1 contacts)
const ghl = axios.create({
  baseURL: "https://rest.gohighlevel.com", // v1 base URL for contacts :contentReference[oaicite:0]{index=0}
  headers: {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    "Content-Type": "application/json",
    Version: "2021-07-28", // required header for many GHL endpoints :contentReference[oaicite:1]{index=1}
  },
});

/**
 * Fetch a contact by ID from GoHighLevel
 * @param {string} contactId
 * @returns {Promise<object|null>}
 */
async function getContact(contactId) {
  if (!contactId) {
    console.warn("getContact called without contactId");
    return null;
  }

  try {
    const res = await ghl.get(`/v1/contacts/${contactId}`);
    // Depending on docs, contact is usually in res.data
    return res.data;
  } catch (err) {
    console.error("❌ Error fetching contact from GHL:", err.response?.status, err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  getContact,
};
