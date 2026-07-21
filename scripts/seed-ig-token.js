// One-off seed for integration_tokens row for meta_ig_barbershop.
// Reads current IG_ACCESS_TOKEN + IG_BUSINESS_ACCOUNT_ID from
// barbershop-website/.env.local. Never prints the token.
const fs = require("fs");
const path = require("path");
require("dotenv").config(); // backend .env for SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
const { createClient } = require("@supabase/supabase-js");

const BARBERSHOP_ENV = "/Users/studioaz/Documents/Studio AZ Tattoo App/barbershop-website/.env.local";

function parseEnv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const out = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

(async () => {
  const bsEnv = parseEnv(BARBERSHOP_ENV);
  const token = bsEnv.IG_ACCESS_TOKEN;
  const bizId = bsEnv.IG_BUSINESS_ACCOUNT_ID;
  if (!token || !bizId) {
    console.error("ERROR: missing IG_ACCESS_TOKEN or IG_BUSINESS_ACCOUNT_ID in barbershop-website/.env.local");
    process.exit(1);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Upsert (idempotent — safe to re-run)
  const { data, error } = await supabase
    .from("integration_tokens")
    .upsert(
      {
        provider: "meta_ig_barbershop",
        access_token: token,
        // IG-native long-lived tokens are 60 days from time of issue.
        // We don't know the original issue date, so budget conservatively.
        expires_at: new Date(Date.now() + 55 * 24 * 60 * 60 * 1000).toISOString(),
        refreshed_at: new Date().toISOString(),
        last_refresh_error: null,
        last_refresh_error_at: null,
        metadata: {
          type: "ig_native",
          ig_business_account_id: bizId,
          app_id: "1712852903196491",
          refresh_endpoint: "https://graph.instagram.com/refresh_access_token",
          graph_base: "https://graph.instagram.com/v25.0",
          notes: "Instagram-native (IGA...) token. Refresh via ig_refresh_token grant type. App Secret NOT required for refresh.",
        },
      },
      { onConflict: "provider" }
    )
    .select("provider, expires_at, refreshed_at, metadata");

  if (error) {
    console.error("Supabase upsert error:", error.message);
    process.exit(1);
  }
  console.log("✓ seeded row for provider=meta_ig_barbershop");
  console.log("  expires_at:", data[0].expires_at);
  console.log("  metadata:", JSON.stringify(data[0].metadata, null, 2));
})();
