const PIPELINE_NAME = "Tattoo";

// Allow overriding via env var but default to known pipeline id for safety
const PIPELINE_ID = process.env.GHL_PIPELINE_ID || "Q4QmvAi6bzvdk1rWRkgV";

const PIPELINE_STAGE_CONFIG = {
  INTAKE: {
    id: "98249178-522e-4a85-9e3f-ccb01df42b18",
    name: "Intake",
    defaultMonetaryValue: 0,
    tags: [],
  },
  DISCOVERY: {
    id: "7303c015-f060-46b6-b944-82204763ac87",
    name: "Discovery",
    defaultMonetaryValue: 0,
    tags: [],
  },
  DEPOSIT_PENDING: {
    id: "04d73009-51fe-4fd3-8207-06673b2aab78",
    name: "Deposit Pending",
    defaultMonetaryValue: 100,
    tags: [],
  },
  QUALIFIED: {
    id: "a4415a16-91b8-43cc-b6be-9766d557596e",
    name: "Qualified (Deposit Paid)",
    defaultMonetaryValue: 100,
    tags: [],
  },
  CONSULT_APPOINTMENT: {
    id: "d30d3a30-3a78-4123-9387-8db3d6dd8a20",
    name: "Consult – Appointment",
    defaultMonetaryValue: 100,
    tags: [],
  },
  CONSULT_MESSAGE: {
    id: "09587a76-13ae-41b3-bd57-81da11f1c56c",
    name: "Consult – Message",
    defaultMonetaryValue: 100,
    tags: [],
  },
  TATTOO_BOOKED: {
    id: "6e53fc11-14e1-4eb7-b8c1-56e8d1ec4982",
    name: "Tattoo Booked",
    defaultMonetaryValue: 600, // average booked value placeholder
    tags: [],
  },
  COMPLETED: {
    id: "27f7e75c-4992-4b16-ba98-455b95f9e479",
    name: "Completed",
    defaultMonetaryValue: 0,
    tags: ["completed"],
  },
  COLD_NURTURE_LOST: {
    id: "d08a4842-ba65-4213-b8c7-92e94295fc88",
    name: "Cold / Nurture / Lost",
    defaultMonetaryValue: 0,
    tags: ["cold_long_term", "cold_undecided", "lost_no_response", "ghosted_after_deposit_link"],
  },
};

const PIPELINE_STAGE_ORDER = [
  "INTAKE",
  "DISCOVERY",
  "DEPOSIT_PENDING",
  "QUALIFIED",
  "CONSULT_APPOINTMENT",
  "CONSULT_MESSAGE",
  "TATTOO_BOOKED",
  "COMPLETED",
  "COLD_NURTURE_LOST",
];

function getStageConfig(stageKey) {
  if (!stageKey) return null;
  return PIPELINE_STAGE_CONFIG[stageKey] || null;
}

function getStageId(stageKey) {
  const cfg = getStageConfig(stageKey);
  return cfg?.id || null;
}

module.exports = {
  PIPELINE_NAME,
  PIPELINE_ID,
  PIPELINE_STAGE_CONFIG,
  PIPELINE_STAGE_ORDER,
  getStageConfig,
  getStageId,
};

