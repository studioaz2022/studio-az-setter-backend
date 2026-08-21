// priceHistory.js — barber price-change detector (GALLERY_RANKING_PLAN.md Phase 5)
//
// The shop's 4 price sources (GHL, barber-prices.md, website lib/barbers.ts,
// Supabase barber_service_prices) never cascade, so this OBSERVES changes
// instead of trusting anyone to log them: every 6h (and once on boot) it
// diffs barber_service_prices against the latest barber_price_history row
// per (calendar_id, service_type) and writes one event per delta.
//
// First sighting of a calendar/service seeds a `baseline` row (old_price
// null) — the anchor every later delta hangs off. Comparisons make the tick
// idempotent: same price → no row, ever. effective_at for detector rows is
// detection time (the true change moment is somewhere inside the last tick).
//
// Consumers (Phase 6+): trajectory graphs with "price → $60" pins, gallery
// receipts ("conversions since the raise"), the AI coach, the iOS Analytics
// tab. The ledger is deliberately generic — nothing gallery-specific here.

const { supabase } = require("../clients/supabaseClient");

const TICK_MS = 6 * 3600 * 1000;

// The walk-in test calendar isn't a real chair — never ledger it.
const SKIP_BARBERS = new Set(["Studio AZ (Test)"]);

/**
 * One detector pass. Returns { baselines, changes } counts for logs/tests.
 */
async function runPriceDetectorOnce() {
  if (!supabase) throw new Error("Storage not configured");

  const [{ data: prices, error: pErr }, { data: history, error: hErr }] =
    await Promise.all([
      supabase
        .from("barber_service_prices")
        .select("calendar_id, barber_name, service_type, price"),
      supabase
        .from("barber_price_history")
        .select("calendar_id, service_type, new_price, effective_at")
        .order("effective_at", { ascending: true }),
    ]);
  if (pErr) throw new Error(pErr.message);
  if (hErr) throw new Error(hErr.message);

  // latest known price per (calendar, service) — ascending order means the
  // last write wins the reduce.
  const latest = new Map();
  for (const h of history || []) {
    latest.set(`${h.calendar_id}|${h.service_type}`, Number(h.new_price));
  }

  const now = new Date().toISOString();
  const rows = [];
  let baselines = 0;
  let changes = 0;

  for (const p of prices || []) {
    if (SKIP_BARBERS.has(p.barber_name)) continue;
    const key = `${p.calendar_id}|${p.service_type}`;
    const current = Number(p.price);
    const known = latest.get(key);
    if (known === undefined) {
      rows.push({
        calendar_id: p.calendar_id,
        barber_slug: p.barber_name.toLowerCase(),
        service_type: p.service_type,
        old_price: null,
        new_price: current,
        effective_at: now,
        source: "baseline",
        notes: "first observation of this calendar/service",
      });
      baselines++;
    } else if (known !== current) {
      rows.push({
        calendar_id: p.calendar_id,
        barber_slug: p.barber_name.toLowerCase(),
        service_type: p.service_type,
        old_price: known,
        new_price: current,
        effective_at: now,
        source: "detector",
        notes: null,
      });
      changes++;
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase.from("barber_price_history").insert(rows);
    if (error) throw new Error(error.message);
  }
  if (baselines || changes) {
    console.log(
      `[PriceHistory] ledgered ${baselines} baselines, ${changes} changes`
    );
  }
  return { baselines, changes };
}

function startPriceDetectorLoop() {
  const tick = async () => {
    try {
      await runPriceDetectorOnce();
    } catch (e) {
      console.error("[PriceHistory] detector tick failed:", e.message);
    }
  };
  setTimeout(tick, 120_000); // startup grace, then every 6h
  setInterval(tick, TICK_MS);
  console.log("[PriceHistory] detector loop started (6h interval)");
}

module.exports = { runPriceDetectorOnce, startPriceDetectorLoop };
