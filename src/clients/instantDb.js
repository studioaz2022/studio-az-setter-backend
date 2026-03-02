const { init } = require("@instantdb/admin");

const db = init({
  appId: "c72e7565-3bf0-47b5-a23d-57ef8afe65b3",
  adminToken: process.env.INSTANT_APP_ADMIN_TOKEN,
});

module.exports = { db };
