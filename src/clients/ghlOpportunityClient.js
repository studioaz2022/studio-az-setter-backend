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
  tags = [],
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
    tags,
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
}) {
  const url = `${GHL_BASE_URL}/opportunities/search`;
  const payload = {
    locationId: GHL_LOCATION_ID,
    query: {
      pipelineId: PIPELINE_ID,
      ...query,
    },
  };

  const response = await axios.post(url, payload, {
    headers: ghlHeaders(),
  });

  return response.data?.opportunities || [];
}

async function getOpportunity(opportunityId) {
  if (!opportunityId) throw new Error("getOpportunity requires opportunityId");
  const url = `${GHL_BASE_URL}/opportunities/${opportunityId}?locationId=${encodeURIComponent(GHL_LOCATION_ID)}`;
  const response = await axios.get(url, { headers: ghlHeaders() });
  return response.data;
}

async function getOpportunitiesByContact({ contactId, pipelineId = PIPELINE_ID }) {
  if (!contactId) throw new Error("getOpportunitiesByContact requires contactId");
  return searchOpportunities({
    query: {
      contactId,
      pipelineId,
    },
    pagination: {
      limit: 50,
      page: 1,
    },
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
};
