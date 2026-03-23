// generateRefreshToken.js
// One-time script to generate a Google OAuth refresh token with Search Console + GBP scopes
//
// Usage:
//   1. Run: node src/seo/generateRefreshToken.js
//   2. It opens your browser automatically
//   3. Sign in with the Google account that owns your Search Console & GBP
//   4. After granting access, the script catches the callback and prints your refresh token
//   5. Copy the refresh token → add to .env as GOOGLE_SEO_REFRESH_TOKEN

require("dotenv").config();
const http = require("http");
const { exec } = require("child_process");

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET in .env");
  process.exit(1);
}

// Scopes needed for SEO toolkit
const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",        // Search Console
  "https://www.googleapis.com/auth/business.manage",             // Google Business Profile
];

const PORT = 3847;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;

async function main() {
  // Step 1: Build auth URL
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log("\n========================================");
  console.log("Google OAuth — SEO Toolkit Authorization");
  console.log("========================================\n");
  console.log("A browser window will open. Sign in with the Google account");
  console.log("that owns your Search Console & Google Business Profile.\n");
  console.log("Waiting for authorization...\n");

  // Step 2: Start a temporary local server to catch the OAuth callback
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname === "/oauth/callback") {
        const authCode = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><h1>Authorization failed</h1><p>Error: ${error}</p><p>You can close this tab.</p></body></html>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (authCode) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1 style="color:#22c55e">✅ Authorization successful!</h1><p>You can close this tab and go back to the terminal.</p></body></html>`);
          server.close();
          resolve(authCode);
          return;
        }

        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>No code received</h1></body></html>");
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(PORT, () => {
      // Open browser automatically
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${openCmd} "${authUrl.toString()}"`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for authorization (5 minutes). Run the script again."));
    }, 5 * 60 * 1000);
  });

  console.log("Authorization code received! Exchanging for tokens...\n");

  // Step 3: Exchange code for tokens
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenResp.json();

  if (tokenData.error) {
    console.error("Error exchanging code:", tokenData.error, tokenData.error_description);
    process.exit(1);
  }

  console.log("========================================");
  console.log("SUCCESS! Here is your refresh token:");
  console.log("========================================\n");
  console.log(tokenData.refresh_token);
  console.log("\nAdd this to your .env file as:");
  console.log("GOOGLE_SEO_REFRESH_TOKEN=" + tokenData.refresh_token);
  console.log("\nAccess token (temporary, for testing):");
  console.log(tokenData.access_token);
  console.log("\nScopes granted:", tokenData.scope);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
