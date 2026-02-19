const { ghl } = require("./ghlSdk");
const { PIPELINE_ID } = require("../config/pipelineConfig");

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

if (!GHL_LOCATION_ID) {
  console.warn("[GHL Opportunities] Missing GHL_LOCATION_ID env var");
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

  // SDK returns response.data directly (same shape as before)
  return ghl.opportunities.createOpportunity(payload);
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

  // SDK returns response.data directly (same shape as before)
  return ghl.opportunities.upsertOpportunity(payload);
}

async function updateOpportunity(opportunityId, body = {}) {
  if (!opportunityId) throw new Error("updateOpportunity requires opportunityId");

  // SDK returns response.data directly (same shape as before)
  return ghl.opportunities.updateOpportunity(
    { id: opportunityId },
    {
      ...body,
      locationId: GHL_LOCATION_ID,
    }
  );
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

  // No SDK method for opportunity notes — use SDK's pre-configured httpClient
  const httpClient = ghl.getHttpClient();
  const response = await httpClient.post(
    `/opportunities/${opportunityId}/notes`,
    { locationId: GHL_LOCATION_ID, content }
  );

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
  if (!contactId && !assignedTo) {
    console.warn(
      "⚠️ [GHL Opportunities] searchOpportunities called without contact_id or assigned_to; returning empty list."
    );
    return [];
  }

  // First page via SDK
  const sdkParams = { locationId };
  if (contactId) sdkParams.contactId = String(contactId);
  if (assignedTo) sdkParams.assignedTo = String(assignedTo);
  if (status && status !== "all") sdkParams.status = String(status);
  if (pagination?.startAfter !== undefined && pagination?.startAfter !== null) {
    sdkParams.startAfter = String(pagination.startAfter);
  }
  if (pagination?.startAfterId) {
    sdkParams.startAfterId = String(pagination.startAfterId);
  }

  // SDK returns response.data directly: { opportunities, meta, traceId }
  const firstPage = await ghl.opportunities.searchOpportunity(sdkParams);
  const results = [...(firstPage?.opportunities || [])];

  // Auto-paginate using SDK's httpClient for subsequent pages
  let nextPageUrl = firstPage?.meta?.nextPageUrl || firstPage?.meta?.nextPageURL || null;
  const httpClient = ghl.getHttpClient();

  while (nextPageUrl) {
    const response = await httpClient.get(nextPageUrl);
    const opportunities = response.data?.opportunities || [];
    results.push(...opportunities);
    nextPageUrl = response.data?.meta?.nextPageUrl || response.data?.meta?.nextPageURL || null;
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
  // SDK returns response.data directly: { opportunity: {...}, traceId }
  return ghl.opportunities.getOpportunity({ id: opportunityId });
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
