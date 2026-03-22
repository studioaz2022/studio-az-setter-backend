// generateRefreshToken.js
// One-time script to generate a Google OAuth refresh token with Search Console + GBP scopes
//
// Usage:
//   1. Run: node src/seo/generateRefreshToken.js
//   2. Open the URL it prints in your browser
//   3. Sign in with the Google account that owns your Search Console & GBP
//   4. Copy the authorization code from the redirect URL
//   5. Paste it back into the terminal
//   6. Copy the refresh token it outputs → add to .env as GOOGLE_SEO_REFRESH_TOKEN

require("dotenv").config();
const readline = require("readline");

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

// Use OOB redirect for CLI flow
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

async function main() {
  // Step 1: Build auth URL
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent"); // Force consent to get refresh token

  console.log("\n========================================");
  console.log("Google OAuth — SEO Toolkit Authorization");
  console.log("========================================\n");
  console.log("1. Open this URL in your browser:\n");
  console.log(authUrl.toString());
  console.log("\n2. Sign in with the Google account that owns your Search Console & GBP.");
  console.log("3. After granting access, Google will show you an authorization code.");
  console.log("4. Copy that code and paste it below.\n");

  // Step 2: Get the code from user
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((resolve) => {
    rl.question("Paste authorization code here: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!code) {
    console.error("No code entered. Exiting.");
    process.exit(1);
  }

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
    console.error("\nError exchanging code:", tokenData.error, tokenData.error_description);
    process.exit(1);
  }

  console.log("\n========================================");
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
  console.error("Fatal error:", err);
  process.exit(1);
});
