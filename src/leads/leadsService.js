// leadsService.js — Query logic for the Leads Command Center
// Fetches opportunities from the tattoo pipeline, enriches with contact data,
// computes alerts and stage counts.

const { searchOpportunities, getOpportunitiesByContact, updateOpportunityStage } = require("../clients/ghlOpportunityClient");
const { getContactsBatch, getContact, updateSystemFields, assignContactToArtist } = require("../clients/ghlClient");
const { PIPELINE_ID, PIPELINE_STAGE_CONFIG, PIPELINE_STAGE_ORDER } = require("../config/pipelineConfig");
const { SYSTEM_FIELDS } = require("../config/constants");

// Stage ID → stage key reverse lookup
const STAGE_ID_TO_KEY = Object.fromEntries(
  Object.entries(PIPELINE_STAGE_CONFIG).map(([key, cfg]) => [cfg.id, key])
);

// Active stages (shown in pipeline strip — excludes terminal stages)
const ACTIVE_STAGES = PIPELINE_STAGE_ORDER.filter(
  (s) => s !== "COMPLETED" && s !== "COLD_NURTURE_LOST"
);

// Thresholds for alerts
const STUCK_DAYS_THRESHOLD = 5;
const DEPOSIT_OVERDUE_DAYS = 3;

/**
 * Fetch all active leads from the tattoo pipeline, enriched with contact data.
 */
async function fetchActiveLeads({ stage, assignedTo, unassigned, sort = "newest", limit = 50, offset = 0 } = {}) {
  // 1. Fetch all open opportunities in the tattoo pipeline
  const searchParams = {
    query: {
      pipelineId: PIPELINE_ID,
      status: "open",
    },
  };

  // If filtering by stage, pass the stage ID to the SDK
  if (stage && PIPELINE_STAGE_CONFIG[stage]) {
    searchParams.query.pipelineStageId = PIPELINE_STAGE_CONFIG[stage].id;
  }

  // If filtering by assigned artist on the opportunity level
  if (assignedTo) {
    searchParams.query.assignedTo = assignedTo;
  }

  const opportunities = await searchOpportunities(searchParams);

  if (!opportunities || opportunities.length === 0) {
    return {
      leads: [],
      stageCounts: buildEmptyStageCounts(),
      alerts: { unassignedHot: 0, stuckLeads: 0, depositOverdue: 0 },
    };
  }

  // 2. Batch-fetch all contacts
  const contactIds = [...new Set(opportunities.map((opp) => opp.contactId || opp.contact_id).filter(Boolean))];
  const contactMap = await getContactsBatch(contactIds);

  // 3. Enrich opportunities with contact data → lead objects
  let leads = opportunities.map((opp) => {
    const cId = opp.contactId || opp.contact_id;
    const contact = contactMap.get(cId);
    return enrichLead(opp, contact);
  });

  // 4. Compute stage counts (before filtering by unassigned)
  const stageCounts = buildStageCounts(leads);

  // 5. Compute alerts (before filtering)
  const alerts = computeAlerts(leads);

  // 6. Apply unassigned filter
  if (unassigned) {
    leads = leads.filter((l) => !l.assignedTo);
  }

  // 7. Sort
  leads = sortLeads(leads, sort);

  // 8. Paginate
  const total = leads.length;
  leads = leads.slice(offset, offset + limit);

  return { leads, stageCounts, alerts, total };
}

/**
 * Enrich an opportunity + contact into a lead object for the API response.
 */
function enrichLead(opp, contact) {
  const cf = contact?.customField || {};
  const stageKey = STAGE_ID_TO_KEY[opp.pipelineStageId] || "UNKNOWN";

  // Compute days in stage
  const stageChangeDate = opp.lastStageChangeAt || opp.lastStatusChangeAt || opp.updatedAt || opp.dateAdded;
  const daysInStage = stageChangeDate
    ? Math.floor((Date.now() - new Date(stageChangeDate).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // Build tattoo summary from available fields
  const parts = [cf.tattoo_style, cf.tattoo_size, cf.tattoo_color_preference].filter(Boolean);
  const tattooSummary = cf.tattoo_summary || parts.join(", ") || null;

  return {
    contactId: opp.contactId || opp.contact_id,
    opportunityId: opp.id || opp._id,
    firstName: contact?.firstName || opp.name?.split(" ")[0] || null,
    lastName: contact?.lastName || opp.name?.split(" ").slice(1).join(" ") || null,
    phone: contact?.phone || null,
    email: contact?.email || null,
    stage: stageKey,
    leadTemperature: cf.lead_temperature || null,
    leadSource: cf.lead_source || null,
    assignedArtist: cf.assigned_artist || null,
    assignedTo: opp.assignedTo || contact?.assignedTo || null,
    tattooSummary,
    tattooStyle: cf.tattoo_style || null,
    tattooSize: cf.tattoo_size || null,
    daysInStage,
    depositPaid: cf.deposit_paid === "Yes" || cf.deposit_paid === "true" || cf.deposit_paid === true,
    dateAdded: opp.dateAdded || contact?.dateAdded || null,
    dateUpdated: opp.updatedAt || opp.dateUpdated || null,
  };
}

/**
 * Build stage counts from leads array. Includes all stages (even with 0 count).
 */
function buildStageCounts(leads) {
  const counts = buildEmptyStageCounts();
  for (const lead of leads) {
    if (counts.hasOwnProperty(lead.stage)) {
      counts[lead.stage]++;
    }
  }
  return counts;
}

function buildEmptyStageCounts() {
  const counts = {};
  for (const stage of PIPELINE_STAGE_ORDER) {
    counts[stage] = 0;
  }
  return counts;
}

/**
 * Compute alert counts for the alert banner.
 */
function computeAlerts(leads) {
  let unassignedHot = 0;
  let stuckLeads = 0;
  let depositOverdue = 0;

  for (const lead of leads) {
    // Hot leads with no assigned artist
    if (lead.leadTemperature === "hot" && !lead.assignedTo) {
      unassignedHot++;
    }

    // Leads stuck in a stage for too long (active stages only)
    if (ACTIVE_STAGES.includes(lead.stage) && lead.daysInStage >= STUCK_DAYS_THRESHOLD) {
      stuckLeads++;
    }

    // Deposit pending for too long
    if (lead.stage === "DEPOSIT_PENDING" && lead.daysInStage >= DEPOSIT_OVERDUE_DAYS) {
      depositOverdue++;
    }
  }

  return { unassignedHot, stuckLeads, depositOverdue };
}

/**
 * Sort leads by the requested criteria.
 */
function sortLeads(leads, sort) {
  switch (sort) {
    case "temperature": {
      const tempOrder = { hot: 0, warm: 1, cold: 2 };
      return leads.sort((a, b) => {
        const aOrder = tempOrder[a.leadTemperature] ?? 3;
        const bOrder = tempOrder[b.leadTemperature] ?? 3;
        return aOrder - bOrder || new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0);
      });
    }
    case "stuck":
      return leads.sort((a, b) => b.daysInStage - a.daysInStage);
    case "newest":
    default:
      return leads.sort((a, b) => new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0));
  }
}

/**
 * Update a lead's pipeline stage. Looks up their opportunity from the contact,
 * then moves it to the new stage.
 */
async function updateLeadStage(contactId, newStageKey) {
  const stageConfig = PIPELINE_STAGE_CONFIG[newStageKey];
  if (!stageConfig) {
    throw new Error(`Invalid stage key: ${newStageKey}`);
  }

  // Find the contact's opportunity
  const contact = await getContact(contactId);
  if (!contact) throw new Error(`Contact ${contactId} not found`);

  const cf = contact.customField || {};
  let opportunityId = cf.opportunity_id;

  if (!opportunityId) {
    // Fall back to searching
    const opps = await getOpportunitiesByContact({ contactId });
    const activeOpp = opps.find((o) => o.status === "open");
    if (!activeOpp) throw new Error(`No active opportunity found for contact ${contactId}`);
    opportunityId = activeOpp.id || activeOpp._id;
  }

  // Update the opportunity stage
  await updateOpportunityStage({
    opportunityId,
    pipelineStageId: stageConfig.id,
  });

  // Keep the contact's system field in sync
  await updateSystemFields(contactId, {
    opportunity_stage: newStageKey,
  });

  return { contactId, opportunityId, stage: newStageKey };
}

/**
 * Assign an artist to a lead. Updates the GHL contact's assignedTo + system fields.
 */
async function assignLeadToArtist(contactId, artistUserId, artistName) {
  // Update the contact's assigned user in GHL
  await assignContactToArtist(contactId, artistUserId);

  // Update system fields
  await updateSystemFields(contactId, {
    assigned_artist: artistName,
    artist_assigned_at: new Date().toISOString(),
  });

  // Fetch enriched contact for response
  const contact = await getContact(contactId);
  const cf = contact?.customField || {};

  return {
    contactId,
    assignedTo: artistUserId,
    assignedArtist: artistName,
    tattooSummary: cf.tattoo_summary || null,
    firstName: contact?.firstName || null,
    lastName: contact?.lastName || null,
  };
}

module.exports = {
  fetchActiveLeads,
  updateLeadStage,
  assignLeadToArtist,
};
