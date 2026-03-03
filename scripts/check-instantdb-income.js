require("dotenv").config();

const { init } = require("@instantdb/admin");

const db = init({
  appId: "c72e7565-3bf0-47b5-a23d-57ef8afe65b3",
  adminToken: process.env.INSTANT_APP_ADMIN_TOKEN,
});

(async () => {
  const { serviceIncome } = await db.query({ serviceIncome: {} });
  console.log("Total serviceIncome records in InstantDB:", serviceIncome.length);

  if (serviceIncome.length > 0) {
    console.log("\nAll records:");
    serviceIncome.forEach((r) => {
      console.log(
        `  ${r.weekOf} | $${r.amount} | ${r.method} | ${r.type} | ${r.senderName} | sq:${r.squarePaymentId || "null"} | venmo:${r.venmoTxId || "null"} | verified:${r.verified}`
      );
    });
  }
})();
