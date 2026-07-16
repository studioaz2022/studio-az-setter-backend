// ============================================================================
// tattooProjectHistory — per-project snapshot / clear / roll core
// (TATTOO_PROJECT_HISTORY_PLAN.md §6, §12, §14, §15)
//
// The Supabase `tattoo_projects` table is the CANONICAL, human-facing ledger
// of a client's tattoo projects (ideas that lapsed AND tattoos executed in
// shop). GHL contact custom fields only ever hold the CURRENT project.
//
// Governing rules:
//  - SNAPSHOT-BEFORE-OVERWRITE INVARIANT (§6a): nothing may clear or overwrite
//    a populated idea until its full field-set is snapshotted here.
//  - The destructive CLEAR runs only on completion or a client-confirmed new
//    idea — never on a heuristic, never on /lead/partial.
//  - The reference-photo FILE_UPLOAD field is snapshotted but NEVER cleared
//    (writing "" to a FILE_UPLOAD drops every field in the payload).
// ============================================================================

const { supabase } = require("../clients/supabaseClient");
const {
  TATTOO_FIELD_IDS,
  IDEA_FIELD_IDS,
  FINAL_PRICE_FIELD_ID,
  QUOTE_TO_CLIENT_FIELD_ID,
  DEPOSIT_PAID_FIELD_ID,
  DEPOSIT_AMOUNT_FIELD_ID,
  PHOTO_REFERENCE_FIELD_ID,
  SYSTEM_CONTEXT_FIELD_IDS,
} = require("../config/tattooIdeaFields");

const TATTOO_LOCATION_ID = "mUemx2jG4wly4kJWBkI4";

// Lazy-required to avoid client require-cycles.
function ghlClient() {
  return require("../clients/ghlClient");
}
function oppClient() {
  return require("../clients/ghlOpportunityClient");
}

// ---------------------------------------------------------------------------
// Reads (contact.customField is keyed by FIELD ID — see config note)
// ---------------------------------------------------------------------------

function cfOf(contact) {
  return contact?.customField || {};
}

function readField(contact, fieldId) {
  const value = cfOf(contact)[fieldId];
  if (value === undefined || value === null) return null;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.trim() === "" ? null : str;
}

/** The 13 idea fields as {friendlyKey: value|null}. */
function readIdeaFields(contact) {
  const out = {};
  for (const [key, id] of Object.entries(IDEA_FIELD_IDS)) {
    out[key] = readField(contact, id);
  }
  return out;
}

/** A populated, current idea exists on the contact (the "dirty" state, §15c). */
function hasOpenIdea(contact) {
  return !!readField(contact, IDEA_FIELD_IDS.tattoo_summary);
}

/** Reference-photo URLs from the FILE_UPLOAD field, normalized to an array. */
function readPhotoUrls(contact) {
  const raw = cfOf(contact)[PHOTO_REFERENCE_FIELD_ID];
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return Object.values(raw);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") return Object.values(parsed);
    } catch (_) {
      /* plain string URL */
    }
    return raw.trim() ? [raw.trim()] : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execution corroboration (§12): executed = money + it actually happened.
// Source: Supabase transactions (Square-fed). A session_payment is the
// strongest signal; deposit-only means paid but not corroborated as done.
// ---------------------------------------------------------------------------

async function corroborateExecution(contactId) {
  if (!supabase) return { executed: false, executedAt: null };
  const { data, error } = await supabase
    .from("transactions")
    .select("transaction_type, gross_amount, session_date, created_at")
    .eq("contact_id", contactId);
  if (error || !data || data.length === 0) {
    return { executed: false, executedAt: null };
  }
  const sessions = data.filter((t) => t.transaction_type === "session_payment");
  if (sessions.length === 0) return { executed: false, executedAt: null };
  const latest = sessions
    .map((t) => new Date(t.session_date || t.created_at))
    .sort((a, b) => b - a)[0];
  return { executed: true, executedAt: latest.toISOString() };
}

// ---------------------------------------------------------------------------
// Snapshot (append-only insert)
// ---------------------------------------------------------------------------

async function nextProjectNumber(contactId) {
  if (!supabase) return 1;
  const { data } = await supabase
    .from("tattoo_projects")
    .select("project_number")
    .eq("contact_id", contactId)
    .order("project_number", { ascending: false })
    .limit(1);
  return (data?.[0]?.project_number || 0) + 1;
}

/**
 * Snapshot the contact's CURRENT idea into tattoo_projects.
 * Never mutates GHL. Returns the inserted row (or null if nothing to save /
 * supabase unavailable). Idempotency guard: `skipIfDuplicateOf` recent-row
 * check is left to callers that loop (completion + new-idea call it once).
 */
async function snapshotProject(
  contactId,
  {
    contact = null,
    status = "abandoned", // abandoned | superseded | completed | active
    source = "backend",
    conversationSummary = null,
    opportunityId = null,
    executed = false,
    executedAt = null,
    closedAt = null,
  } = {}
) {
  if (!supabase) {
    console.warn("[ProjectHistory] Supabase unavailable — snapshot skipped");
    return null;
  }
  const contactRecord = contact || (await ghlClient().getContact(contactId));
  if (!contactRecord) {
    console.warn(`[ProjectHistory] Cannot load contact ${contactId} — snapshot skipped`);
    return null;
  }

  const idea = readIdeaFields(contactRecord);
  if (!idea.tattoo_summary && !idea.tattoo_title && !idea.tattoo_placement) {
    console.log(`[ProjectHistory] No idea content on ${contactId} — nothing to snapshot`);
    return null;
  }

  const row = {
    contact_id: contactId,
    location_id: TATTOO_LOCATION_ID,
    opportunity_id: opportunityId,
    project_number: await nextProjectNumber(contactId),
    status,
    executed,
    executed_at: executedAt,
    tattoo_title: idea.tattoo_title,
    tattoo_summary: idea.tattoo_summary,
    tattoo_placement: idea.tattoo_placement,
    tattoo_style: idea.tattoo_style,
    tattoo_size: idea.tattoo_size,
    tattoo_color_preference: idea.tattoo_color_preference,
    budget_range: idea.budget_range,
    how_soon_deciding: idea.how_soon_is_client_deciding,
    first_tattoo: idea.first_tattoo,
    tattoo_concerns: idea.tattoo_concerns,
    tattoo_photo_description: idea.tattoo_photo_description,
    design_readiness: idea.design_readiness,
    consultation_preference: idea.consultation_preference,
    reference_photo_urls: readPhotoUrls(contactRecord),
    assigned_technician: readField(contactRecord, SYSTEM_CONTEXT_FIELD_IDS.assigned_technician),
    inquired_technician: readField(contactRecord, TATTOO_FIELD_IDS.inquired_technician),
    final_price: parseFloat(readField(contactRecord, FINAL_PRICE_FIELD_ID)) || null,
    quote_to_client: readField(contactRecord, QUOTE_TO_CLIENT_FIELD_ID),
    deposit_paid: /^(yes|true)$/i.test(readField(contactRecord, DEPOSIT_PAID_FIELD_ID) || ""),
    deposit_amount_usd: parseFloat(readField(contactRecord, DEPOSIT_AMOUNT_FIELD_ID)) || null,
    conversation_summary: conversationSummary,
    source,
    closed_at: closedAt || (status === "active" ? null : new Date().toISOString()),
  };

  const { data, error } = await supabase
    .from("tattoo_projects")
    .insert(row)
    .select()
    .single();
  if (error) {
    console.error(`[ProjectHistory] Snapshot insert failed for ${contactId}:`, error.message);
    return null;
  }
  console.log(
    `[ProjectHistory] Snapshotted project #${data.project_number} (${status}${executed ? ", executed" : ""}) for ${contactId}`
  );
  return data;
}

// ---------------------------------------------------------------------------
// Clear (the destructive step — only completion or confirmed new idea)
// ---------------------------------------------------------------------------

/**
 * Blank the ENTIRE idea field group (plus money fields) in ONE update, so no
 * fragment of the old idea can mix into the next one (§1 Problem A). The
 * FILE_UPLOAD reference-photo field is intentionally NOT touched.
 * When `apply` is provided (friendlyKey -> value), its values are written in
 * the same single payload (clear-then-set collapsed together, §6).
 */
async function clearIdeaFields(contactId, { apply = {} } = {}) {
  const customField = {};
  for (const [key, id] of Object.entries(IDEA_FIELD_IDS)) {
    const incoming = apply[key];
    customField[id] = incoming === undefined || incoming === null ? "" : String(incoming);
  }
  customField[FINAL_PRICE_FIELD_ID] = "";
  customField[QUOTE_TO_CLIENT_FIELD_ID] = "";
  customField[DEPOSIT_PAID_FIELD_ID] = "";
  customField[DEPOSIT_AMOUNT_FIELD_ID] = "";

  await ghlClient().updateContact(contactId, { customField });
  const applied = Object.keys(apply).filter((k) => apply[k] != null);
  console.log(
    `[ProjectHistory] Cleared idea group for ${contactId}` +
      (applied.length ? ` and applied new: ${applied.join(", ")}` : "")
  );
}

// ---------------------------------------------------------------------------
// Opportunity roll (§14a — GHL-native: close old status, next ensure mints new)
// ---------------------------------------------------------------------------

/**
 * Close the contact's open opportunity so the (open-only) finder mints a
 * fresh one at INTAKE on the next touch. `status`: "won" for an executed
 * completion, "abandoned" for a lapsed idea.
 */
async function closeCurrentOpportunity(contactId, { status = "abandoned", monetaryValue } = {}) {
  try {
    const { searchOpportunities, closeOpportunity } = oppClient();
    const open = await searchOpportunities({ query: { contactId, status: "open" } });
    if (!open || open.length === 0) {
      console.log(`[ProjectHistory] No open opportunity for ${contactId} — nothing to close`);
      return null;
    }
    const results = [];
    for (const opp of open) {
      const id = opp.id || opp._id;
      await closeOpportunity({ opportunityId: id, status, monetaryValue });
      results.push(id);
    }
    console.log(`[ProjectHistory] Closed opportunity ${results.join(", ")} (${status}) for ${contactId}`);
    return results[0] || null;
  } catch (err) {
    console.error(`[ProjectHistory] closeCurrentOpportunity failed for ${contactId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Nurture neutralization (§14c)
// ---------------------------------------------------------------------------

/** Stamp the contact's active fill token(s) so the hourly nudge sweep skips them. */
async function neutralizeFillTokens(contactId) {
  if (!supabase) return;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("fill_tokens")
    .update({ nudge_sent_at: now, nudge_outcome: "superseded_by_new_idea" })
    .eq("contact_id", contactId)
    .is("submitted_at", null)
    .is("nudge_sent_at", null)
    .select("token");
  if (error) {
    console.warn(`[ProjectHistory] fill_tokens neutralize failed for ${contactId}:`, error.message);
    return;
  }
  if (data?.length) {
    console.log(`[ProjectHistory] Neutralized ${data.length} fill token(s) for ${contactId}`);
  }
}

/** Cancel pending v2 scheduled follow-ups (no-op while the feature is disabled). */
async function cancelPendingFollowups(contactId) {
  try {
    const { cancelFollowups } = require("../ai/v2/followupScheduler");
    await cancelFollowups(contactId);
  } catch (err) {
    console.warn(`[ProjectHistory] cancelFollowups failed for ${contactId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Orchestrations
// ---------------------------------------------------------------------------

/**
 * COMPLETION (§10 Phase 1): snapshot the finished project (executed when
 * corroborated by a Square session payment), clear the idea group, close the
 * opportunity as won. Returns the snapshot row.
 */
async function handleCompletionSnapshotAndReset(
  contactId,
  { contact = null, conversationSummary = null, opportunityId = null } = {}
) {
  const contactRecord = contact || (await ghlClient().getContact(contactId));
  if (!contactRecord) return null;

  const { executed, executedAt } = await corroborateExecution(contactId);
  const finalPrice = parseFloat(readField(contactRecord, FINAL_PRICE_FIELD_ID)) || undefined;

  const row = await snapshotProject(contactId, {
    contact: contactRecord,
    status: "completed",
    source: "completion",
    conversationSummary,
    opportunityId,
    executed,
    executedAt,
  });

  // Snapshot-before-overwrite invariant: only clear if the snapshot landed
  // (or there was nothing to snapshot).
  if (row || !hasOpenIdea(contactRecord)) {
    await clearIdeaFields(contactId);
    const closedOppId = await closeCurrentOpportunity(contactId, {
      status: "won",
      monetaryValue: finalPrice,
    });
    if (row && closedOppId && !row.opportunity_id && supabase) {
      await supabase.from("tattoo_projects").update({ opportunity_id: closedOppId }).eq("id", row.id);
    }
  } else {
    console.warn(
      `[ProjectHistory] Snapshot failed for ${contactId} — SKIPPING clear (invariant)`
    );
  }
  await neutralizeFillTokens(contactId);
  return row;
}

/**
 * CONFIRMED NEW IDEA (§10 Phase 2, §15 Tier 3): snapshot the old idea as
 * superseded, clear the group AND apply the new idea's fields in one write,
 * close the old opportunity as abandoned, neutralize nurture.
 * `newIdeaFields` is {friendlyKey: value} (only idea-group keys are applied).
 */
async function handleNewTattooIdea(
  contactId,
  { contact = null, newIdeaFields = {}, source = "funnel", conversationSummary = null } = {}
) {
  const contactRecord = contact || (await ghlClient().getContact(contactId));
  if (!contactRecord) throw new Error(`handleNewTattooIdea: cannot load contact ${contactId}`);

  let snapshot = null;
  if (hasOpenIdea(contactRecord)) {
    snapshot = await snapshotProject(contactId, {
      contact: contactRecord,
      status: "superseded",
      source,
      conversationSummary,
    });
    if (!snapshot) {
      // Invariant: never destroy an idea we failed to snapshot.
      throw new Error(
        `handleNewTattooIdea: snapshot failed for ${contactId} — refusing to clear`
      );
    }
  }

  await clearIdeaFields(contactId, { apply: newIdeaFields });

  const closedOppId = await closeCurrentOpportunity(contactId, { status: "abandoned" });
  if (snapshot && closedOppId && supabase) {
    await supabase.from("tattoo_projects").update({ opportunity_id: closedOppId }).eq("id", snapshot.id);
  }

  await neutralizeFillTokens(contactId);
  await cancelPendingFollowups(contactId);
  return snapshot;
}

module.exports = {
  readIdeaFields,
  readPhotoUrls,
  hasOpenIdea,
  corroborateExecution,
  snapshotProject,
  clearIdeaFields,
  closeCurrentOpportunity,
  neutralizeFillTokens,
  handleCompletionSnapshotAndReset,
  handleNewTattooIdea,
};
