require("dotenv").config({ quiet: true });
const express = require("express");
const dashboardRoutes = require("../src/seo/dashboardRoutes");
const app = express();
app.use(express.json());
// Skip auth for the smoke test.
app.use("/dashboard", dashboardRoutes);
const server = app.listen(0, async () => {
  const port = server.address().port;
  console.log("Listening on", port);
  const http = require("http");
  function get(path) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "localhost", port, path, method: "GET" }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  try {
    const r1 = await get("/dashboard/operations/refunds/tattoo?days=7");
    console.log("TATTOO:", r1.status, r1.body.slice(0, 500));
    const r2 = await get("/dashboard/operations/refunds/barbershop");
    console.log("BARBER:", r2.status, r2.body.slice(0, 200));
    const r3 = await get("/dashboard/operations/refunds/zzz");
    console.log("BAD SITE:", r3.status, r3.body.slice(0, 100));
  } catch (e) {
    console.error("Smoke failed:", e.message);
  } finally {
    server.close();
  }
});
