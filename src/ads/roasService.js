// ─── ROAS readout — attributed revenue ÷ billed ad spend ────────────
//
// The ⚑ROAS North Star's arithmetic, made queryable (Ads workspace
// doctrine: no kill/scale verdict without revenue attribution). The join
// never touches Meta's attribution or GHL's search API:
//
//   booking_attribution.lead_campaign LIKE '<prefix>%'   (who the ads sent)
//     → their confirmed transactions (service + tip, our Square/Venmo rails)
//     → ÷ ad_spend_ledger debits                          (what Lionel billed)
//
// The ad URLs stamp utm_campaign=gilberto_gamble / gilberto_marine, the
// widget freezes it as first-touch leadCampaign, bookingCreate.js writes
// it to booking_attribution — so the cohort is exactly "people a Gilberto
// ad brought in", forever (our attribution never expires, unlike Meta's
// 7-day window).
//
// Revenue counts the cohort's WHOLE barbershop wallet (any barber, any
// visit — LTV thinking, doctrine: judge leads by what they're worth),
// with a per-artist breakdown so spillover is visible. `confirmed` sums
// only barber-reviewed rows; `total` includes sync-on-sight rows whose
// auto-match hasn't been confirmed yet.

const { supabase, fetchAllRows } = require("../clients/supabaseClient");

const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

/** "Gilberto Castro" → "gilberto_" — matches the utm_campaign convention
 *  (per-variant tags all share the artist's first name as their stem). */
function prefixFromArtistName(artistName) {
  const first = String(artistName || "").trim().split(/\s+/)[0].toLowerCase();
  return first ? `${first.replace(/[^a-z0-9]/g, "")}_` : null;
}

/**
 * @param {object} mapping   active artist_ad_mappings row (adsService.getActiveMapping)
 * @param {object} opts      { prefix?, since?, until? } — since/until (ISO dates)
 *                           window the TRANSACTIONS; cohort membership and
 *                           ledger spend are all-time (a pilot has one epoch).
 */
async function getRoasReadout(mapping, { prefix, since, until } = {}) {
  const campaignPrefix = prefix || prefixFromArtistName(mapping.artist_name);
  if (!campaignPrefix) throw new Error("No campaign prefix derivable — pass ?prefix=");

  // 1. The cohort: every contact an ad with this campaign stem brought in.
  const { data: attrRows, error: attrErr } = await fetchAllRows(
    supabase
      .from("booking_attribution")
      .select("contact_id, lead_campaign, created_at")
      .like("lead_campaign", `${campaignPrefix}%`)
      .order("created_at", { ascending: true }),
    { label: "roas-cohort" }
  );
  if (attrErr) throw new Error(`booking_attribution read failed: ${attrErr.message}`);
  const contactIds = [...new Set((attrRows || []).map((r) => r.contact_id))];

  // 2. Their money: confirmed session payments across the whole shop.
  let revenue = { total: 0, confirmed: 0, transactions: 0, byArtist: {} };
  if (contactIds.length) {
    let q = supabase
      .from("transactions")
      .select(
        "contact_id, artist_ghl_id, service_price, tip_amount, gross_amount, " +
          "session_date, reviewed_at, transaction_type"
      )
      .in("contact_id", contactIds)
      .eq("transaction_type", "session_payment")
      .is("deleted_at", null)
      .is("superseded_by", null);
    if (since) q = q.gte("session_date", since);
    if (until) q = q.lte("session_date", until);
    const { data: txRows, error: txErr } = await fetchAllRows(q, { label: "roas-revenue" });
    if (txErr) throw new Error(`transactions read failed: ${txErr.message}`);

    for (const tx of txRows || []) {
      const svcTip = num(tx.service_price) + num(tx.tip_amount);
      const value = svcTip > 0 ? svcTip : num(tx.gross_amount);
      if (!(value > 0)) continue;
      revenue.total = +(revenue.total + value).toFixed(2);
      if (tx.reviewed_at) revenue.confirmed = +(revenue.confirmed + value).toFixed(2);
      revenue.transactions += 1;
      const artist = tx.artist_ghl_id || "unknown";
      revenue.byArtist[artist] = +((revenue.byArtist[artist] || 0) + value).toFixed(2);
    }
  }

  // 3. The spend side: what the ledger has billed this artist (debits are
  //    real Meta spend accrued per period; credits are repayments and do
  //    not change ROAS — spend is spend regardless of settlement).
  const { data: ledgerRows, error: ledErr } = await supabase
    .from("ad_spend_ledger")
    .select("entry_type, amount")
    .eq("ghl_user_id", mapping.ghl_user_id);
  if (ledErr) throw new Error(`ad_spend_ledger read failed: ${ledErr.message}`);
  const spend = +(ledgerRows || [])
    .filter((r) => r.entry_type === "debit")
    .reduce((s, r) => s + num(r.amount), 0)
    .toFixed(2);

  return {
    campaignPrefix,
    window: { since: since || null, until: until || null },
    cohort: {
      contacts: contactIds.length,
      bookings: (attrRows || []).length,
      firstAttributedAt: attrRows?.[0]?.created_at || null,
      lastAttributedAt: attrRows?.[attrRows.length - 1]?.created_at || null,
    },
    revenue,
    spend: { ledgerDebits: spend },
    // Null until there's spend — a 0-spend ROAS would read as verdict data.
    roas: spend > 0 ? +(revenue.total / spend).toFixed(2) : null,
    roasConfirmed: spend > 0 ? +(revenue.confirmed / spend).toFixed(2) : null,
  };
}

module.exports = { getRoasReadout, prefixFromArtistName };
