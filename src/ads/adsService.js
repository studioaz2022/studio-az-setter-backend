// adsService.js — Meta ad-set insights per artist, with Supabase-backed caching.
//
// Ads Transparency feature (ADS_TRANSPARENCY_PLAN.md Phase 2).
// artist_ad_mappings resolves ghl_user_id → meta_ad_set_id; insights are pulled
// at ad-set level via the shared Meta SDK singleton and normalized to a stable
// shape the iOS models bind to. Field gotchas (audited 2026-07-17): raw API
// returns strings, actions come as [{action_type, value}], and any field can be
// absent — normalize defensively, never assume scalars.

const { AdSet } = require("../clients/metaAdsSdk");
const { supabase } = require("../clients/supabaseClient");

const CACHE_TTL_MINUTES = 60;

const ALLOWED_PRESETS = new Set([
  "today",
  "yesterday",
  "last_7d",
  "last_14d",
  "last_28d",
  "last_30d",
  "last_90d",
  "this_month",
  "last_month",
  "this_year",
  "last_year",
  "maximum",
]);

const INSIGHT_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "actions",
  "cost_per_action_type",
  "date_start",
  "date_stop",
];

/** Active mapping for one artist (client_acquisition lanes only). */
async function getActiveMapping(ghlUserId) {
  const { data, error } = await supabase
    .from("artist_ad_mappings")
    .select("*")
    .eq("ghl_user_id", ghlUserId)
    .eq("active", true)
    .limit(1);
  if (error) throw new Error(`artist_ad_mappings lookup failed: ${error.message}`);
  return data?.[0] || null;
}

/** Every active mapping — owner overview (includes shop-level recruitment rows). */
async function getAllActiveMappings() {
  const { data, error } = await supabase
    .from("artist_ad_mappings")
    .select("*")
    .eq("active", true)
    .order("brand")
    .order("artist_name");
  if (error) throw new Error(`artist_ad_mappings list failed: ${error.message}`);
  return data || [];
}

/** Validate range params → { params, rangeKey }. Throws on bad input. */
function buildRange({ preset, since, until }) {
  if (since || until) {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRe.test(since || "") || !dateRe.test(until || "")) {
      throw Object.assign(
        new Error("since and until must both be YYYY-MM-DD"),
        { statusCode: 400 }
      );
    }
    return {
      params: { time_range: JSON.stringify({ since, until }) },
      rangeKey: `${since}_${until}`,
    };
  }
  const p = preset || "last_30d";
  if (!ALLOWED_PRESETS.has(p)) {
    throw Object.assign(new Error(`unsupported preset: ${p}`), { statusCode: 400 });
  }
  return { params: { date_preset: p }, rangeKey: p };
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Pull one action_type's value out of an actions-style array. */
function actionValue(actions, actionType) {
  if (!Array.isArray(actions)) return null;
  const hit = actions.find((a) => a?.action_type === actionType);
  return hit ? num(hit.value) : null;
}

/**
 * Normalize one raw insights row (SDK returns strings / omits fields freely).
 * Leads: 'lead' is Meta's combined total; the grouped variants split form vs
 * pixel leads when present. costPerLead prefers Meta's own figure, falls back
 * to spend/leads.
 */
function normalizeInsights(raw, rangeKey) {
  const row = raw?._data || raw || {};
  const actions = row.actions || [];
  const spend = num(row.spend);
  const leads = actionValue(actions, "lead");
  const metaCostPerLead = actionValue(row.cost_per_action_type, "lead");

  return {
    range: {
      key: rangeKey,
      dateStart: row.date_start || null,
      dateStop: row.date_stop || null,
    },
    spend,
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    ctr: num(row.ctr),
    cpc: num(row.cpc),
    cpm: num(row.cpm),
    leads,
    formLeads: actionValue(actions, "onsite_conversion.lead_grouped"),
    websiteLeads: actionValue(actions, "offsite_conversion.fb_pixel_lead"),
    costPerLead:
      metaCostPerLead ?? (spend && leads ? +(spend / leads).toFixed(2) : null),
    // full pass-through so iOS can surface a campaign's native optimization
    // result (e.g. barbershop's "Website appointments scheduled" custom conv.)
    actions: Array.isArray(actions)
      ? actions.map((a) => ({ actionType: a.action_type, value: num(a.value) }))
      : [],
    hasDelivery: spend !== null && spend > 0,
  };
}

/** Fetch fresh insights from Meta for one mapping. */
async function fetchFromMeta(mapping, rangeParams, rangeKey) {
  const adSet = new AdSet(mapping.meta_ad_set_id);
  const rows = await adSet.getInsights(INSIGHT_FIELDS, rangeParams);
  if (!rows || rows.length === 0) {
    // no delivery in this window — zeroed shape, not an error
    return normalizeInsights({}, rangeKey);
  }
  return normalizeInsights(rows[0], rangeKey);
}

/** Cached read: fresh snapshot if within TTL, else Meta + write-through. */
async function getInsightsForMapping(mapping, { preset, since, until, force }) {
  const { params, rangeKey } = buildRange({ preset, since, until });

  if (!force) {
    const cutoff = new Date(Date.now() - CACHE_TTL_MINUTES * 60_000).toISOString();
    const { data: cached } = await supabase
      .from("ad_insights_snapshots")
      .select("payload, fetched_at")
      .eq("mapping_id", mapping.id)
      .eq("range_key", rangeKey)
      .gte("fetched_at", cutoff)
      .order("fetched_at", { ascending: false })
      .limit(1);
    if (cached?.[0]) {
      return { metrics: cached[0].payload, cached: true, fetchedAt: cached[0].fetched_at };
    }
  }

  const metrics = await fetchFromMeta(mapping, params, rangeKey);
  const fetchedAt = new Date().toISOString();
  const { error: insertError } = await supabase.from("ad_insights_snapshots").insert({
    mapping_id: mapping.id,
    ghl_user_id: mapping.ghl_user_id,
    range_key: rangeKey,
    payload: metrics,
    fetched_at: fetchedAt,
  });
  if (insertError) {
    console.warn(`[Ads] snapshot cache write failed: ${insertError.message}`);
  }
  return { metrics, cached: false, fetchedAt };
}

/** Public mapping shape — never leak internal ids beyond what iOS needs. */
function mappingSummary(mapping) {
  return {
    artistName: mapping.artist_name,
    ghlUserId: mapping.ghl_user_id,
    brand: mapping.brand,
    purpose: mapping.purpose,
    campaignId: mapping.meta_campaign_id,
    adSetId: mapping.meta_ad_set_id,
    pixelId: mapping.meta_pixel_id,
  };
}

module.exports = {
  getActiveMapping,
  getAllActiveMappings,
  getInsightsForMapping,
  mappingSummary,
  // exported for tests
  buildRange,
  normalizeInsights,
};
