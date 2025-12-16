const axios = require("axios");
const { PIPELINE_ID } = require("../config/pipelineConfig");

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_FILE_UPLOAD_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const GHL_BASE_URL = "https://services.leadconnectorhq.com";

if (!GHL_FILE_UPLOAD_TOKEN) {
  console.warn("[GHL Opportunities] Missing GHL_FILE_UPLOAD_TOKEN env var");
}

if (!GHL_LOCATION_ID) {
  console.warn("[GHL Opportunities] Missing GHL_LOCATION_ID env var");
}

function ghlHeaders() {
  return {
    Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    Version: "2021-07-28",
  };
}

async function createOpportunity({
  contactId,
  name,
  pipelineId = PIPELINE_ID,
  pipelineStageId,
  status = "open",
  monetaryValue = 0,
  source = "AI Setter",
  assignedUserId = null,
}) {
  if (!contactId) throw new Error("createOpportunity requires contactId");
  if (!pipelineId) throw new Error("createOpportunity requires pipelineId");
  if (!pipelineStageId) throw new Error("createOpportunity requires pipelineStageId");
  if (!GHL_LOCATION_ID) throw new Error("GHL_LOCATION_ID is missing");

  const payload = {
    locationId: GHL_LOCATION_ID,
    pipelineId,
    pipelineStageId,
    contactId,
    name: name || "Tattoo Opportunity",
    status,
    monetaryValue,
    source,
  };

  if (assignedUserId) {
    payload.assignedUserId = assignedUserId;
  }

  const url = `${GHL_BASE_URL}/opportunities/`;

  const response = await axios.post(url, payload, {
    headers: ghlHeaders(),
  });

  return response.data;
}

async function upsertOpportunity({
  contactId,
  name,
  pipelineId = PIPELINE_ID,
  pipelineStageId,
  status = "open",
  monetaryValue = 0,
  source = "AI Setter",
  assignedTo = null,
  assignedUserId = null,
}) {
  if (!contactId) throw new Error("upsertOpportunity requires contactId");
  if (!pipelineId) throw new Error("upsertOpportunity requires pipelineId");
  if (!pipelineStageId) throw new Error("upsertOpportunity requires pipelineStageId");
  if (!GHL_LOCATION_ID) throw new Error("GHL_LOCATION_ID is missing");

  const payload = {
    locationId: GHL_LOCATION_ID,
    pipelineId,
    pipelineStageId,
    contactId,
    name: name || "Tattoo Opportunity",
    status,
    monetaryValue,
    source,
  };

  // GHL API expects "assignedTo"; accept assignedUserId for backwards compatibility
  const finalAssignee = assignedTo || assignedUserId;
  if (finalAssignee) {
    payload.assignedTo = finalAssignee;
  }

  const url = `${GHL_BASE_URL}/opportunities/upsert`;

  const response = await axios.post(url, payload, {
    headers: ghlHeaders(),
    maxBodyLength: Infinity,
  });

  return response.data;
}

async function updateOpportunity(opportunityId, body = {}) {
  if (!opportunityId) throw new Error("updateOpportunity requires opportunityId");

  const url = `${GHL_BASE_URL}/opportunities/${opportunityId}`;
  const response = await axios.put(
    url,
    {
      ...body,
      locationId: GHL_LOCATION_ID,
    },
    { headers: ghlHeaders() }
  );

  return response.data;
}

async function updateOpportunityStage({ opportunityId, pipelineStageId, status }) {
  if (!pipelineStageId) throw new Error("updateOpportunityStage requires pipelineStageId");
  const body = { pipelineStageId, pipelineId: PIPELINE_ID };
  if (status) body.status = status;
  return updateOpportunity(opportunityId, body);
}

async function updateOpportunityValue({ opportunityId, monetaryValue }) {
  return updateOpportunity(opportunityId, { monetaryValue });
}

async function closeOpportunity({ opportunityId, status = "won", monetaryValue }) {
  const body = { status };
  if (typeof monetaryValue === "number") body.monetaryValue = monetaryValue;
  return updateOpportunity(opportunityId, body);
}

async function addOpportunityNote({ opportunityId, content }) {
  if (!opportunityId) throw new Error("addOpportunityNote requires opportunityId");
  if (!content) return null;

  const url = `${GHL_BASE_URL}/opportunities/${opportunityId}/notes`;
  const payload = {
    locationId: GHL_LOCATION_ID,
    content,
  };

  const response = await axios.post(url, payload, {
    headers: ghlHeaders(),
  });

  return response.data;
}

async function searchOpportunities({
  query = {},
  pagination = null,
}) {
  // NOTE: LeadConnector/GHL supports searching opportunities via GET:
  // /opportunities/search?location_id=...&contact_id=...
  // /opportunities/search?location_id=...&assigned_to=...&status=open
  // Supported status values: open, won, lost, abandoned, all
  // This avoids 422 errors seen with the POST schema.
  const q = query || {};
  const contactId = q.contactId || q.contact_id || null;
  const assignedTo = q.assignedTo || q.assigned_to || null;
  const status = q.status || null; // Supported by API: open, won, lost, abandoned, all
  const pipelineStageId = q.pipelineStageId || q.pipeline_stage_id || null; // Client-side filtering
  const locationId = q.locationId || q.location_id || GHL_LOCATION_ID;

  if (!locationId) {
    throw new Error("GHL_LOCATION_ID is missing");
  }

  // Build query params - require at least contactId OR assignedTo
  const params = new URLSearchParams();
  params.set("location_id", String(locationId));

  if (contactId) {
    params.set("contact_id", String(contactId));
  } else if (assignedTo) {
    params.set("assigned_to", String(assignedTo));
  } else {
    // No supported filter provided
    console.warn(
      "⚠️ [GHL Opportunities] searchOpportunities called without contact_id or assigned_to; returning empty list."
    );
    return [];
  }

  // Add status filter to API request (supported: open, won, lost, abandoned, all)
  if (status && status !== "all") {
    params.set("status", String(status));
  }

  // Optional pagination inputs for first page
  if (pagination?.startAfter !== undefined && pagination?.startAfter !== null) {
    params.set("startAfter", String(pagination.startAfter));
  }
  if (pagination?.startAfterId) {
    params.set("startAfterId", String(pagination.startAfterId));
  }

  // Fetch all pages
  let url = `${GHL_BASE_URL}/opportunities/search?${params.toString()}`;
  const results = [];

  while (url) {
    const response = await axios.get(url, { headers: ghlHeaders() });
    const opportunities = response.data?.opportunities || [];
    results.push(...opportunities);

    // Check for next page
    const nextPageUrl = response.data?.meta?.nextPageUrl || response.data?.meta?.nextPageURL || null;
    url = nextPageUrl || null;
  }

  // Client-side filtering for pipelineStageId (not supported by API)
  let filtered = results;
  if (pipelineStageId) {
    filtered = filtered.filter(
      (opp) => opp.pipelineStageId === pipelineStageId || opp.pipeline_stage_id === pipelineStageId
    );
  }

  return filtered;
}

async function getOpportunity(opportunityId) {
  if (!opportunityId) throw new Error("getOpportunity requires opportunityId");
  const url = `${GHL_BASE_URL}/opportunities/${opportunityId}?locationId=${encodeURIComponent(GHL_LOCATION_ID)}`;
  const response = await axios.get(url, { headers: ghlHeaders() });
  return response.data;
}

async function getOpportunitiesByContact({ contactId, pipelineId = PIPELINE_ID }) {
  if (!contactId) throw new Error("getOpportunitiesByContact requires contactId");
  // Use GET /opportunities/search?location_id=...&contact_id=...
  // pipelineId is kept for signature compatibility but is not required for the GET-by-contact endpoint.
  return searchOpportunities({
    query: { contactId, pipelineId },
  });
}

module.exports = {
  createOpportunity,
  updateOpportunity,
  updateOpportunityStage,
  updateOpportunityValue,
  closeOpportunity,
  addOpportunityNote,
  getOpportunity,
  getOpportunitiesByContact,
  searchOpportunities,
  upsertOpportunity,
};