// ledgerService.js — per-artist running balance for fronted Meta ad spend.
//
// Ads Transparency Phase 4. Debits are spend accruals pulled from Meta for an
// explicit period; credits are repayments (Venmo, posted by the owner). The
// accrual is idempotent per (artist, period) via a partial unique index, so
// re-running a period can never double-bill anyone. Zero-spend periods write
// nothing — paused campaigns must not generate noise rows.

const { supabase } = require("../clients/supabaseClient");
const { getAllActiveMappings, getInsightsForMapping } = require("./adsService");

const num = (v) => (v === null || v === undefined ? 0 : Number(v));

/** Full statement for one artist: entries (newest first) + running balance. */
async function getLedger(ghlUserId) {
  const { data, error } = await supabase
    .from("ad_spend_ledger")
    .select("*")
    .eq("ghl_user_id", ghlUserId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`ad_spend_ledger read failed: ${error.message}`);

  const entries = (data || []).map((row) => ({
    id: row.id,
    entryType: row.entry_type,
    amount: num(row.amount),
    periodStart: row.period_start,
    periodEnd: row.period_end,
    source: row.source,
    externalRef: row.external_ref,
    note: row.note,
    createdAt: row.created_at,
  }));

  const totalDebits = entries
    .filter((e) => e.entryType === "debit")
    .reduce((sum, e) => sum + e.amount, 0);
  const totalCredits = entries
    .filter((e) => e.entryType === "credit")
    .reduce((sum, e) => sum + e.amount, 0);
  const lastCredit = entries.find((e) => e.entryType === "credit");

  return {
    entries,
    totalDebits: +totalDebits.toFixed(2),
    totalCredits: +totalCredits.toFixed(2),
    balance: +(totalDebits - totalCredits).toFixed(2),
    lastCreditAt: lastCredit ? lastCredit.createdAt : null,
  };
}

/** Owner-posted repayment. externalRef (Venmo tx id) dedups via unique index. */
async function postCredit(ghlUserId, { amount, source, externalRef, note }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error("amount must be a positive number"), { statusCode: 400 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("ghl_user_id", ghlUserId)
    .limit(1);
  const artistName = profile?.[0]?.full_name || ghlUserId;

  const { data, error } = await supabase
    .from("ad_spend_ledger")
    .insert({
      ghl_user_id: ghlUserId,
      artist_name: artistName,
      entry_type: "credit",
      amount: value,
      source: source || "venmo",
      external_ref: externalRef || null,
      note: note || null,
    })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      throw Object.assign(
        new Error(`credit with external_ref "${externalRef}" already posted`),
        { statusCode: 409 }
      );
    }
    throw new Error(`credit insert failed: ${error.message}`);
  }
  return data;
}

/**
 * Accrue real Meta spend as debits for every active client-acquisition lane.
 * Explicit period only — the caller says exactly what window is being billed.
 * Returns one result per lane: accrued | skipped_no_spend | already_accrued | error.
 */
async function accrueForPeriod({ since, until }) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(since || "") || !dateRe.test(until || "")) {
    throw Object.assign(new Error("since and until must both be YYYY-MM-DD"), { statusCode: 400 });
  }

  const mappings = (await getAllActiveMappings()).filter(
    (m) => m.purpose === "client_acquisition" && m.ghl_user_id
  );

  const results = [];
  for (const mapping of mappings) {
    try {
      const { metrics } = await getInsightsForMapping(mapping, { since, until, force: true });
      const spend = num(metrics.spend);
      if (spend <= 0) {
        results.push({ artist: mapping.artist_name, status: "skipped_no_spend" });
        continue;
      }

      const { error } = await supabase.from("ad_spend_ledger").insert({
        ghl_user_id: mapping.ghl_user_id,
        artist_name: mapping.artist_name,
        entry_type: "debit",
        amount: spend,
        period_start: since,
        period_end: until,
        source: "meta_accrual",
        note: `Ad spend ${since} → ${until} (ad set ${mapping.meta_ad_set_id})`,
      });
      if (error) {
        if (error.code === "23505") {
          results.push({ artist: mapping.artist_name, status: "already_accrued" });
          continue;
        }
        throw new Error(error.message);
      }
      results.push({ artist: mapping.artist_name, status: "accrued", amount: spend });
    } catch (err) {
      results.push({ artist: mapping.artist_name, status: "error", error: err.message });
    }
  }
  return { since, until, results };
}

module.exports = { getLedger, postCredit, accrueForPeriod };
