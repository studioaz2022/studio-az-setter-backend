#!/usr/bin/env node
/* ─── Re-mint GOOGLE_SEO_REFRESH_TOKEN with Search Console WRITE ────────
 *
 * The existing token carries `webmasters.readonly`, so submitting a
 * sitemap returns 403. This re-runs the OAuth consent asking for the
 * full `webmasters` scope instead.
 *
 * IT REQUESTS EVERY SCOPE THE CURRENT TOKEN ALREADY HAS, plus the write
 * one. Google issues a token for exactly what you ask for, so requesting
 * only Search Console would silently drop GBP and GA4 access and break
 * the SEO toolkit.
 *
 *   node scripts/reauth-google-seo.js
 *
 * It prints a URL, waits on http://localhost:<port> for the redirect,
 * then prints the new refresh token. Put that in .env AND in Render's
 * env vars (production reads Render).
 */
require("dotenv").config();
const http = require("http");
const crypto = require("crypto");

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("GOOGLE_OAUTH_CLIENT_ID / _SECRET missing from .env");
  process.exit(1);
}

// Superset of what the current token holds. `webmasters` (write) replaces
// `webmasters.readonly` — it includes read.
const SCOPES = [
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/business.manage",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/analytics.edit",
];

const PORT = Number(process.env.OAUTH_PORT || 8737);
const REDIRECT = `http://localhost:${PORT}`;
const state = crypto.randomBytes(16).toString("hex");

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    // offline + consent is what actually returns a refresh token; without
    // `prompt=consent` Google reuses the existing grant and returns none.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

console.log(`\nRedirect URI in use: ${REDIRECT}`);
console.log("(must be registered on the OAuth client — a Desktop-app client allows any localhost port)\n");
console.log("Open this and approve as support@studioaz.us:\n");
console.log(authUrl + "\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (!url.searchParams.get("code") && !url.searchParams.get("error")) {
    res.writeHead(404).end();
    return;
  }
  const err = url.searchParams.get("error");
  if (err) {
    res.writeHead(200, { "Content-Type": "text/plain" }).end(`Denied: ${err}`);
    console.error("\nDenied:", err);
    server.close();
    process.exit(1);
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("state mismatch");
    console.error("\nstate mismatch — aborting");
    server.close();
    process.exit(1);
  }

  const body = new URLSearchParams({
    code: url.searchParams.get("code"),
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tok = await r.json();
  res.writeHead(200, { "Content-Type": "text/html" }).end(
    "<h2>Done — back to the terminal.</h2>"
  );
  server.close();

  if (!tok.refresh_token) {
    console.error("\nNo refresh_token returned:", JSON.stringify(tok).slice(0, 400));
    console.error("Usually means the grant already existed — prompt=consent should prevent that.");
    process.exit(1);
  }

  // Prove the new token actually carries the write scope before anyone
  // pastes it anywhere.
  const info = await fetch(
    `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${tok.access_token}`
  ).then((x) => x.json());
  const scopes = (info.scope || "").split(" ").sort();
  const hasWrite = scopes.includes("https://www.googleapis.com/auth/webmasters");

  console.log("\nScopes granted:");
  for (const s of scopes) console.log("  " + s);
  console.log(`\nSearch Console WRITE: ${hasWrite ? "YES" : "NO — do not use this token"}`);
  console.log("\nGOOGLE_SEO_REFRESH_TOKEN=" + tok.refresh_token);
  console.log("\nPut it in backend .env AND Render env vars, then redeploy.\n");
});

server.listen(PORT, () => console.log(`Listening on ${REDIRECT} …\n`));
