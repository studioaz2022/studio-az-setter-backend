// verifyBackfilledSnapshots.js
//
// Post-backfill verification. After running Step 5 (8-week snapshot backfill),
// this script reads the persisted snapshots back and reports:
//
//   1. Coverage: how many snapshot rows exist per barber across the window
//   2. Pooled utilization using EXACT equivalents (Option B math)
//   3. Pooled utilization using ROUNDED slot counts (the wrong way)
//   4. The delta between them — confirms storing equivalents was worth it
//   5. Mode breakdown (should be "historical" for most past days)
//   6. Sanity column presence (any snapshot row missing new Option B fields?)
//
// Usage:
//   node scripts/verifyBackfilledSnapshots.js [start=2026-03-15] [end=2026-05-10]

require("dotenv").config();
const { supabase } = require("../src/clients/supabaseClient");
const { BARBER_DATA, BARBER_LOCATION_ID } = require("../src/config/kioskConfig");

const startDate = process.argv[2] || "2026-03-15";
const endDate = process.argv[3] || "2026-05-10";

(async () => {
  console.log(`Snapshot verification: ${startDate} → ${endDate}`);
  console.log("=".repeat(120));

  const headerCols = ["Barber", "Days", "Sched", "OccEq", "OvtEq", "PoolUtil%", "RoundedUtil%", "Δ", "Modes"];
  console.log(headerCols.join("\t"));

  let totalRowsChecked = 0;
  let rowsMissingEquivalents = 0;

  for (const barber of BARBER_DATA) {
    const { data, error } = await supabase
      .from("barber_analytics_snapshots")
      .select(
        "snapshot_date,scheduled_slots,occupied_slots,occupied_equivalents,overtime_slots,overtime_equivalents,snapshot_mode",
      )
      .eq("barber_ghl_id", barber.ghlUserId)
      .eq("location_id", BARBER_LOCATION_ID)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate)
      .order("snapshot_date");

    if (error) {
      console.log(`${barber.name}\tERR\t${error.message}`);
      continue;
    }

    const workedDays = (data || []).filter((r) => (r.scheduled_slots || 0) > 0);
    totalRowsChecked += workedDays.length;

    let totalSched = 0;
    let totalOccEq = 0;
    let totalOvtEq = 0;
    let totalOccRounded = 0;
    let totalOvtRounded = 0;
    const modeCounts = {};

    for (const r of workedDays) {
      totalSched += r.scheduled_slots || 0;
      totalOccRounded += r.occupied_slots || 0;
      totalOvtRounded += r.overtime_slots || 0;

      // Detect rows missing the new Option B fields (would happen if a row
      // was written by an old version of the snapshot cron pre-Step 4).
      if (r.occupied_equivalents == null) rowsMissingEquivalents++;

      totalOccEq += parseFloat(r.occupied_equivalents || r.occupied_slots || 0);
      totalOvtEq += parseFloat(r.overtime_equivalents || r.overtime_slots || 0);

      const mode = r.snapshot_mode || "?";
      modeCounts[mode] = (modeCounts[mode] || 0) + 1;
    }

    if (totalSched === 0) {
      console.log(`${barber.name}\t${workedDays.length}\t0\t-\t-\t-\t-\t-\t-`);
      continue;
    }

    const poolUtilExact = ((totalOccEq + totalOvtEq) / totalSched * 100).toFixed(1);
    const poolUtilRounded = ((totalOccRounded + totalOvtRounded) / totalSched * 100).toFixed(1);
    const delta = (parseFloat(poolUtilRounded) - parseFloat(poolUtilExact)).toFixed(1);
    const modeStr = Object.entries(modeCounts).map(([m, c]) => `${m}:${c}`).join(",");

    console.log(
      [
        barber.name.padEnd(18),
        workedDays.length,
        totalSched,
        totalOccEq.toFixed(1),
        totalOvtEq.toFixed(1),
        poolUtilExact + "%",
        poolUtilRounded + "%",
        (delta >= 0 ? "+" : "") + delta + "%",
        modeStr,
      ].join("\t"),
    );
  }

  console.log("=".repeat(120));
  console.log(`Rows checked: ${totalRowsChecked}`);
  console.log(`Rows missing occupied_equivalents: ${rowsMissingEquivalents}`);
  if (rowsMissingEquivalents > 0) {
    console.log("  ↳ Those rows were probably written before Step 4 — the new pooling math falls back to rounded slots for them.");
  }
})();
