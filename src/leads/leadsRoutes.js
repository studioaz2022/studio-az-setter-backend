// leadsRoutes.js — API routes for the Leads Command Center
// Mounted at /api/leads in app.js

const express = require("express");
const router = express.Router();
const { fetchActiveLeads, updateLeadStage, assignLeadToArtist } = require("./leadsService");
const { sendPushToGhlUser } = require("../services/taskNotifications");

// GET /api/leads/active
// Query params: stage, assignedTo, unassigned, sort, limit, offset
router.get("/active", async (req, res) => {
  try {
    const {
      stage,
      assignedTo,
      unassigned,
      sort = "newest",
      limit = "50",
      offset = "0",
    } = req.query;

    const result = await fetchActiveLeads({
      stage: stage || undefined,
      assignedTo: assignedTo || undefined,
      unassigned: unassigned === "true",
      sort,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("❌ GET /api/leads/active error:", err.message || err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/leads/:contactId/stage
// Body: { stage: "DEPOSIT_PENDING" }
router.put("/:contactId/stage", async (req, res) => {
  try {
    const { contactId } = req.params;
    const { stage } = req.body || {};

    if (!stage) {
      return res.status(400).json({ success: false, error: "stage is required" });
    }

    const result = await updateLeadStage(contactId, stage);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error(`❌ PUT /api/leads/${req.params.contactId}/stage error:`, err.message || err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/leads/:contactId/assign
// Body: { artistUserId: "1wuLf50VMODExBSJ9xPI", artistName: "Joan" }
router.put("/:contactId/assign", async (req, res) => {
  try {
    const { contactId } = req.params;
    const { artistUserId, artistName } = req.body || {};

    if (!artistUserId || !artistName) {
      return res.status(400).json({ success: false, error: "artistUserId and artistName are required" });
    }

    const result = await assignLeadToArtist(contactId, artistUserId, artistName);

    // Send push notification to the artist
    const tattooSummary = result.tattooSummary || "";
    const contactName = [result.firstName, result.lastName].filter(Boolean).join(" ") || "New lead";
    const body = tattooSummary ? `${contactName} — ${tattooSummary}` : contactName;

    sendPushToGhlUser(artistUserId, (language) => ({
      type: "lead_assigned",
      title: language === "es" ? "Nuevo lead asignado" : "New Lead Assigned",
      body,
      contactId,
    })).catch((err) => console.error("❌ [LEAD APN] Error:", err.message || err));

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error(`❌ PUT /api/leads/${req.params.contactId}/assign error:`, err.message || err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
