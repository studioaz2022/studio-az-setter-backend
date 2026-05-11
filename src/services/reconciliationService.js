/**
 * Reconciliation math engine. Pure functions, no DB calls, no fetches.
 *
 * Every screen, endpoint, and notification that talks about money owed
 * between client/shop/artist must call into this module. Two screens
 * disagreeing on the same number is a violation of Vision #12 in
 * TATTOO_FINANCE_PLAN.md.
 *
 * Internal math is in INTEGER CENTS to avoid floating-point drift. The
 * existing `transactions` table stores amounts as NUMERIC dollars; we
 * convert at the boundary on every read and convert back on every output.
 *
 * Commission rates: every transaction snapshots `shop_percentage` and
 * `artist_percentage` at write time, so historical math stays consistent
 * even if a rate changes later. We sum what's already there.
 *
 * Stripe 6% financing fee handling: the webhook records `gross_amount =
 * original quote` (the commission base) — the +6% surplus is captured in
 * `notes` and absorbed by the shop. The math engine reads `gross_amount`
 * directly without re-adjusting; the shop fee is shop overhead, not a
 * deduction from the artist's share or the contract balance.
 */

const { formatWeekRange, toShopDateString } = require("../utils/dateUtils");

const VENMO_NOTE_MAX_LEN = 280;

// ---------- conversion helpers ----------

function dollarsToCents(d) {
  if (d == null || d === "") return 0;
  const n = typeof d === "number" ? d : Number(d);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function centsToDollars(c) {
  return Math.round(c) / 100;
}

function isRefundTransaction(tx) {
  const type = (tx?.transaction_type || "").toLowerCase();
  return type.includes("refund") || dollarsToCents(tx?.gross_amount) < 0;
}

// ---------- per-contact reconciliation ----------

/**
 * Reconcile a single contact's project given the contract quote and a list
 * of transaction rows from the `transactions` table.
 *
 * @param {object} args
 * @param {number|string|null} args.quote   The contract quote in dollars (final_price).
 * @param {Array<object>} args.transactions Transaction rows.
 * @param {number} [args.shopPercentage]    Override for the contract split.
 *                                          Defaults to the artist's current rate
 *                                          (must be supplied by caller from
 *                                          `artist_commission_rates`). If omitted,
 *                                          falls back to 30 (shop policy default).
 * @returns {object} Pure-data summary, all dollar fields rounded to 2dp.
 */
function computeContactReconciliation({ quote, transactions, shopPercentage }) {
  const quoteCents = dollarsToCents(quote);
  const hasQuote = quote != null && quoteCents > 0;
  const shopPct = shopPercentage == null ? 30 : Number(shopPercentage);
  const artistPct = 100 - shopPct;

  let shopActualCents = 0;
  let artistActualCents = 0;
  let shopOwedFromTxCents = 0;   // what each tx says shop should ultimately receive
  let artistOwedFromTxCents = 0;

  for (const tx of transactions || []) {
    const grossCents = dollarsToCents(tx.gross_amount);
    const shopAmtCents = dollarsToCents(tx.shop_amount);
    const artistAmtCents = dollarsToCents(tx.artist_amount);
    const recipient = tx.payment_recipient;

    if (recipient === "shop") {
      shopActualCents += grossCents;
    } else if (recipient === "artist_direct") {
      artistActualCents += grossCents;
    } else {
      // Unknown recipient: treat as shop-collected (safest for client-side ledger).
      shopActualCents += grossCents;
    }
    shopOwedFromTxCents += shopAmtCents;
    artistOwedFromTxCents += artistAmtCents;
  }

  const collectedCents = shopActualCents + artistActualCents;

  // Contract-level expectations (what each party SHOULD receive over the project).
  const shopShouldReceiveCents = hasQuote
    ? Math.round((quoteCents * shopPct) / 100)
    : shopOwedFromTxCents; // fallback: sum of per-tx splits
  const artistShouldReceiveCents = hasQuote
    ? quoteCents - shopShouldReceiveCents
    : artistOwedFromTxCents;

  // Net direction: positive = shop owes artist, negative = artist owes shop.
  // shop has too much money? → it owes the artist their share of what shop collected
  // artist has too much money? → it owes the shop the shop's share of what artist collected
  const shopSurplusCents = shopActualCents - shopShouldReceiveCents;
  const netToArtistCents = shopSurplusCents; // positive when shop over-collected (= shop owes artist)

  return {
    quote: hasQuote ? centsToDollars(quoteCents) : null,
    shopPercentage: shopPct,
    artistPercentage: artistPct,
    shopShouldReceive: centsToDollars(shopShouldReceiveCents),
    artistShouldReceive: centsToDollars(artistShouldReceiveCents),
    shopActualReceived: centsToDollars(shopActualCents),
    artistActualReceived: centsToDollars(artistActualCents),
    collected: centsToDollars(collectedCents),
    outstanding: hasQuote ? centsToDollars(quoteCents - collectedCents) : null,
    netToArtist: centsToDollars(netToArtistCents),
    isFullyPaid: hasQuote ? collectedCents >= quoteCents : false,
    isOverpaid: hasQuote ? collectedCents > quoteCents : false,
    transactionCount: (transactions || []).length,
  };
}

// ---------- weekly aggregation ----------

/**
 * Aggregate completed projects for an artist into a weekly reconciliation.
 *
 * @param {object} args
 * @param {string} args.artistGhlId
 * @param {string} args.artistName            For Venmo code generation.
 * @param {Date}   args.weekStart             Monday 00:00 shop tz (UTC instant).
 * @param {Date}   args.weekEnd               Sunday 23:59:59.999 shop tz.
 * @param {Array<object>} args.completions    Rows from `project_completions`.
 *                                            Must include net_to_artist (number),
 *                                            contact_id, contact_name (or fallback
 *                                            looked up by caller), quote_at_completion,
 *                                            collected_at_completion.
 * @returns {object}
 */
function computeWeeklyReconciliation({
  artistGhlId,
  artistName,
  weekStart,
  weekEnd,
  completions,
}) {
  const projects = (completions || []).map((c) => ({
    contactId: c.contact_id,
    contactName: c.contact_name || "Unknown Client",
    quote: Number(c.quote_at_completion),
    collected: Number(c.collected_at_completion),
    netToArtist: Number(c.net_to_artist),
    completedAt: c.completed_at,
  }));

  const totalNetCents = projects.reduce(
    (sum, p) => sum + dollarsToCents(p.netToArtist),
    0
  );
  const totalNet = centsToDollars(totalNetCents);

  const direction =
    totalNetCents > 0
      ? "shop_owes_artist"
      : totalNetCents < 0
      ? "artist_owes_shop"
      : "settled";

  const venmoCode = generateVenmoCode({ artistName, weekStart });
  const venmoNote = formatVenmoNote({
    weekStart,
    weekEnd,
    projects,
    totalNet,
    venmoCode,
    direction,
  });

  return {
    artistGhlId,
    weekStart: toShopDateString(weekStart),
    weekEnd: toShopDateString(weekEnd),
    completedProjects: projects,
    totalNetToArtist: totalNet,
    netAmount: Math.abs(totalNet),
    direction,
    venmoCode,
    venmoNote,
    projectCount: projects.length,
  };
}

// ---------- venmo helpers ----------

/**
 * Generate a per-week artist code: first 3 letters of first name (uppercased)
 * + MMDD of week start. e.g. "CHA0427" for Claudia, week starting Apr 27.
 *
 * Caller is responsible for collision-handling at the DB level — the
 * `reconciliations.venmo_code` UNIQUE constraint means a duplicate insert
 * fails, and the caller can retry with a numeric suffix.
 */
function generateVenmoCode({ artistName, weekStart, suffix }) {
  const first = (artistName || "ART").trim().split(/\s+/)[0] || "ART";
  const prefix = first
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3)
    .padEnd(3, "X");
  const dateStr = toShopDateString(weekStart); // "YYYY-MM-DD"
  const mmdd = dateStr.slice(5, 7) + dateStr.slice(8, 10);
  return suffix ? `${prefix}${mmdd}-${suffix}` : `${prefix}${mmdd}`;
}

/**
 * Format the Venmo payout note. Pattern:
 *   "StudioAZ Recon Apr 20-26 · Maria Garcia, Jose Lopez · Net $1260 to artist · [a:CHA0427]"
 *   "StudioAZ Recon May 11-17 · Jose J · Net $3 to shop · [a:AND0511]"
 *
 * Truncates the client list with "+ N more" if the full note would exceed
 * 280 chars. The artist code marker stays at the end so the parser can
 * always extract it.
 */
function formatVenmoNote({ weekStart, weekEnd, projects, totalNet, venmoCode, direction }) {
  const range = formatWeekRange(weekStart, weekEnd);
  const netStr = `$${Math.round(Math.abs(totalNet))}`;
  // Direction qualifier so the recipient knows which way money flows.
  // The parser only depends on the [a:CODE] marker + $amount, so extra
  // text is safe to add.
  const directionStr =
    direction === "shop_owes_artist" ? " to artist"
    : direction === "artist_owes_shop" ? " to shop"
    : "";
  const codeMarker = `[a:${venmoCode}]`;
  const fixedSuffix = ` · Net ${netStr}${directionStr} · ${codeMarker}`;
  const fixedPrefix = `StudioAZ Recon ${range} · `;
  const budget = VENMO_NOTE_MAX_LEN - fixedPrefix.length - fixedSuffix.length;

  const names = projects.map((p) => p.contactName || "Unknown Client");
  let included = [];
  let used = 0;
  for (let i = 0; i < names.length; i++) {
    const sep = included.length === 0 ? "" : ", ";
    const candidate = sep + names[i];
    const trailing = i < names.length - 1 ? `, + ${names.length - i - 1} more` : "";
    if (used + candidate.length + trailing.length > budget) {
      const remaining = names.length - i;
      if (remaining > 0) included.push(`+ ${remaining} more`);
      break;
    }
    included.push(names[i]);
    used += candidate.length;
  }

  const namesPart = included.length > 0 ? included.join(", ") : "(no clients)";
  return `${fixedPrefix}${namesPart}${fixedSuffix}`;
}

module.exports = {
  computeContactReconciliation,
  computeWeeklyReconciliation,
  generateVenmoCode,
  formatVenmoNote,
  isRefundTransaction,
  dollarsToCents,
  centsToDollars,
  VENMO_NOTE_MAX_LEN,
};
