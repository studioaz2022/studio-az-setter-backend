/**
 * Grid-Walk Verification Script
 *
 * Tests the grid-walk implementation against 3 known worked examples
 * from GRID_WALK_UTILIZATION_PLAN.md.
 *
 * Usage: node scripts/gridWalkVerify.js
 */

require("dotenv").config();

const { getChairUtilization } = require("../src/analytics/analyticsQueries");

const LOCATION_ID = "GLRkNAxfPtWTqTiN83xj";
const LIONEL_ID = "1kFG5FWdUDhXLUX46snG";

const TESTS = [
  {
    name: "Saturday March 14 (Lionel)",
    barber: LIONEL_ID,
    date: "2026-03-14",
    expected: {
      // HC + HC F&F union: 10:00-14:30 = 9 slots, 1 break-blocked = 8 scheduled
      // 8 occupied + 2 overtime (Shawn Messner at 14:30) = 125%
      scheduledSlots: 8,
      occupiedSlots: 8,
      overtimeSlots: 2,
      breakBlockedSlots: 1,
      manuallyBlockedSlots: 0,
      utilization: 125, // (8+2)/8 = 125%
    },
  },
  {
    name: "Tuesday March 3 (Lionel)",
    barber: LIONEL_ID,
    date: "2026-03-03",
    expected: {
      scheduledSlots: 7,
      occupiedSlots: 7,
      overtimeSlots: 0,
      breakBlockedSlots: 1,
      manuallyBlockedSlots: 0,
      utilization: 100, // 7/7 = 100%
    },
  },
  {
    name: "Wednesday Feb 25 (Lionel)",
    barber: LIONEL_ID,
    date: "2026-02-25",
    // Note: In the plan this is Wednesday Feb 25 but let's verify what day Feb 25 2026 is
    expected: {
      scheduledSlots: 8,
      occupiedSlots: 8,
      overtimeSlots: 0,
      breakBlockedSlots: 4,
      manuallyBlockedSlots: 1,
      utilization: 100, // 8/8 = 100%
    },
  },
];

async function main() {
  console.log("Grid-Walk Verification\n" + "=".repeat(60) + "\n");

  let passed = 0;
  let failed = 0;

  for (const test of TESTS) {
    console.log(`▸ ${test.name} (${test.date})`);

    try {
      const result = await getChairUtilization(test.barber, LOCATION_ID, 1, test.date);

      console.log(`  Mode: ${result.mode}, ScheduleSource: ${result.scheduleSource}`);
      console.log(`  Scheduled: ${result.scheduledSlots}, Occupied: ${result.occupiedSlots}, Overtime: ${result.overtimeSlots}`);
      console.log(`  BreakBlocked: ${result.breakBlockedSlots}, ManuallyBlocked: ${result.manuallyBlockedSlots}`);
      console.log(`  Utilization: ${result.utilization}%`);
      console.log(`  DeadSpace: ${result.deadSpaceMinutes}min, HcDeadSpace: ${result.hcDeadSpaceMinutes}min`);
      console.log(`  AvailabilityIndex: ${result.availabilityIndex}%, ShopImpact: ${result.shopImpact}%`);
      console.log(`  Legacy — Capacity: ${result.capacityMinutes}min, Utilized: ${result.utilizedMinutes}min, Free: ${result.freeSlotMinutes}min`);

      // Verify expectations
      const checks = [];
      for (const [key, expectedVal] of Object.entries(test.expected)) {
        const actual = result[key];
        const pass = actual === expectedVal;
        checks.push({ key, expected: expectedVal, actual, pass });
        if (!pass) {
          console.log(`  ❌ ${key}: expected ${expectedVal}, got ${actual}`);
        }
      }

      const allPassed = checks.every(c => c.pass);
      if (allPassed) {
        console.log(`  ✅ All checks passed`);
        passed++;
      } else {
        console.log(`  ❌ ${checks.filter(c => !c.pass).length} check(s) failed`);
        failed++;
      }
    } catch (err) {
      console.log(`  ❌ ERROR: ${err.message}`);
      failed++;
    }

    console.log();
  }

  console.log("=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
