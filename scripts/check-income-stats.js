require("dotenv").config();
const { init } = require("@instantdb/admin");
const db = init({ appId: "c72e7565-3bf0-47b5-a23d-57ef8afe65b3", adminToken: process.env.INSTANT_APP_ADMIN_TOKEN });

(async () => {
  const { serviceIncome } = await db.query({ serviceIncome: {} });
  const sorted = serviceIncome.sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  console.log("Total records:", serviceIncome.length);
  console.log("Earliest weekOf:", sorted[0] && sorted[0].weekOf);
  console.log("Latest weekOf:", sorted[sorted.length - 1] && sorted[sorted.length - 1].weekOf);

  // Count by month
  const months = {};
  sorted.forEach(r => {
    const m = r.weekOf.slice(0, 7);
    months[m] = (months[m] || 0) + 1;
  });
  console.log("\nRecords by month:");
  Object.entries(months).sort().forEach(([m, c]) => console.log("  " + m + ": " + c));

  // Check verified status
  const verified = serviceIncome.filter(r => r.verified).length;
  const unverified = serviceIncome.filter(r => r.verified === false).length;
  console.log("\nVerified:", verified, "Unverified:", unverified);

  const squareUnverified = serviceIncome.filter(r => r.method === "square" && r.verified === false).length;
  console.log("Square unverified:", squareUnverified);
})();
