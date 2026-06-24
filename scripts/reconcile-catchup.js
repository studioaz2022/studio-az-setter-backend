// One-shot reconcile to backfill cache rows missed during the
// 2026-06-20 → 2026-06-24 GHL appointment-webhook outage. Window:
// past 5 days through next 60. Reads via the existing reconciler,
// which is additive (never deletes) so it's safe to run repeatedly.
//
// Run with prod env (Supabase + GHL credentials):
//   node scripts/reconcile-catchup.js
//
// Env required: SUPABASE_URL, SUPABASE_KEY (or SERVICE_ROLE), GHL pit tokens.

require("dotenv").config();

(async () => {
  const { reconcileAllLocations } = require("../src/clients/appointmentReconciler");
  console.log("[catchup] starting reconcile — past 5d → next 60d, both locations");
  const t = Date.now();
  try {
    const agg = await reconcileAllLocations({
      pastDays: 5,
      futureDays: 60,
      dryRun: false,
    });
    const dt = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`[catchup] done in ${dt}s`);
    console.log(JSON.stringify(agg, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("[catchup] FAILED:", err);
    process.exit(1);
  }
})();
