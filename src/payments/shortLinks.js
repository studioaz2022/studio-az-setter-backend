// shortLinks.js
// Shared short link generator for pay.studioaztattoo.com
// Used by both Stripe financing links and Square deposit links.

const { createClient } = require("@supabase/supabase-js");

const SHORT_LINK_BASE_URL = "https://pay.studioaztattoo.com";
const SHORT_CODE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const SHORT_CODE_LENGTH = 6;

function generateShortCode() {
  let code = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += SHORT_CODE_CHARS[Math.floor(Math.random() * SHORT_CODE_CHARS.length)];
  }
  return code;
}

/**
 * Create a short link: pay.studioaztattoo.com/:code → destinationUrl
 * @param {string} destinationUrl - Full URL to redirect to
 * @param {string|null} sessionId - Optional Stripe session ID or Square checkout link ID
 * @returns {{ code: string, shortUrl: string }}
 */
async function createShortLink(destinationUrl, sessionId = null) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Retry up to 5 times on collision (extremely unlikely with 36^6 = 2.1B combinations)
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShortCode();
    const { error } = await supabase.from("short_links").insert({
      code,
      destination_url: destinationUrl,
      session_id: sessionId,
    });
    if (!error) {
      return { code, shortUrl: `${SHORT_LINK_BASE_URL}/${code}` };
    }
    if (!error.message?.includes("unique")) throw error;
  }
  throw new Error("Failed to generate unique short code after 5 attempts");
}

module.exports = { createShortLink };
