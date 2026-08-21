// backfill-price-history.js — infer historical price changes from the
// transactions ledger (GALLERY_RANKING_PLAN.md Phase 5 backfill).
//
// Usage:
//   node scripts/backfill-price-history.js           # dry run: print candidates
//   node scripts/backfill-price-history.js --write   # insert source='backfill' rows
//
// HOUSE RULE: the dry-run list is reviewed by Lionel BEFORE --write. Inferred
// history that's wrong is worse than no history.
//
// Method: per (calendar_id, service_type), monthly modal service_price from
// non-refund, non-deleted transactions. A candidate change = the dominant
// price in one month differs from the previous dominant, and BOTH sides have
// >= MIN_TXNS transactions backing them (one-off amounts are discounts, not
// prices). effective_at = first day of the first month at the new price.
//
// DEPOSIT NORMALIZATION (verified against real data): calendars with
// deposit_percentage=50 record service_price as the CHARGED HALF (Lionel's
// $80 cut books as $40). Modal prices on those calendars are doubled before
// comparison — without this the script invents a fake price drop for every
// deposit barber.
//
// Coverage honesty: booth renters paid outside shop systems leave no
// transactions, so inference is strong only where the ledger is deep
// (Chavez, Gilberto today). Thin calendars produce no candidates — absence
// of evidence is reported, not guessed at.

require("dotenv").config();
const { supabase } = require("../src/clients/supabaseClient");

const MIN_TXNS = 3; // both the old and new dominant price need this many
const WRITE = process.argv.includes("--write");

async function main() {
  if (!supabase) throw new Error("Storage not configured");

  const [{ data: prices, error: pErr }, { data: txns, error: tErr }] =
    await Promise.all([
      supabase
        .from("barber_service_prices")
        .select("calendar_id, barber_name, service_type, deposit_percentage"),
      supabase
        .from("transactions")
        .select("calendar_id, service_price, session_date, transaction_type")
        .not("service_price", "is", null)
        .not("calendar_id", "is", null)
        .is("deleted_at", null)
        .is("superseded_by", null)
        .limit(50000),
    ]);
  if (pErr) throw new Error(pErr.message);
  if (tErr) throw new Error(tErr.message);

  const meta = new Map(prices.map((p) => [p.calendar_id, p]));

  // (calendar|month) → price → count
  const buckets = new Map();
  for (const t of txns) {
    if (t.transaction_type === "refund") continue;
    const m = meta.get(t.calendar_id);
    if (!m || m.barber_name === "Studio AZ (Test)") continue;
    if (!t.session_date) continue;
    const month = t.session_date.slice(0, 7);
    const factor = m.deposit_percentage === 50 ? 2 : 1;
    const price = Number(t.service_price) * factor;
    const key = `${t.calendar_id}|${month}`;
    let byPrice = buckets.get(key);
    if (!byPrice) {
      byPrice = new Map();
      buckets.set(key, byPrice);
    }
    byPrice.set(price, (byPrice.get(price) || 0) + 1);
  }

  // calendar → [{month, price, count}] dominant per month, threshold-gated
  const dominants = new Map();
  for (const [key, byPrice] of buckets) {
    const [calendarId, month] = key.split("|");
    let best = null;
    for (const [price, count] of byPrice) {
      if (!best || count > best.count) best = { price, count };
    }
    if (!best || best.count < MIN_TXNS) continue;
    let arr = dominants.get(calendarId);
    if (!arr) {
      arr = [];
      dominants.set(calendarId, arr);
    }
    arr.push({ month, ...best });
  }

  const candidates = [];
  for (const [calendarId, arr] of dominants) {
    arr.sort((a, b) => a.month.localeCompare(b.month));
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].price !== arr[i - 1].price) {
        const m = meta.get(calendarId);
        candidates.push({
          calendar_id: calendarId,
          barber_slug: m.barber_name.toLowerCase(),
          service_type: m.service_type,
          old_price: arr[i - 1].price,
          new_price: arr[i].price,
          effective_at: `${arr[i].month}-01T00:00:00Z`,
          source: "backfill",
          notes:
            `inferred from transactions: ${arr[i - 1].count} txns @ $${arr[i - 1].price} ` +
            `(${arr[i - 1].month}) → ${arr[i].count} txns @ $${arr[i].price} (${arr[i].month})` +
            (m.deposit_percentage === 50 ? "; deposit calendar, prices ×2-normalized" : ""),
        });
      }
    }
  }

  console.log(`\n${candidates.length} candidate price event(s):\n`);
  for (const c of candidates) {
    console.log(
      `  ${c.barber_slug} · ${c.service_type} · $${c.old_price} → $${c.new_price} · effective ${c.effective_at.slice(0, 10)}`
    );
    console.log(`    ${c.notes}\n`);
  }

  if (!WRITE) {
    console.log("Dry run — nothing written. Re-run with --write after review.");
    return;
  }

  if (candidates.length > 0) {
    const { error } = await supabase.from("barber_price_history").insert(candidates);
    if (error) throw new Error(error.message);
  }
  console.log(`Wrote ${candidates.length} backfill row(s).`);
}

main().catch((e) => {
  console.error("backfill failed:", e.message);
  process.exit(1);
});
