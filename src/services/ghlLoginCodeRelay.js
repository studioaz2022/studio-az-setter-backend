// ghlLoginCodeRelay.js
//
// Relays the GHL "Login security code" one-time code from the work inbox
// (support@studioaz.us) into a Discord channel, so a barber standing at the
// front desk can read the code without anyone opening the owner's email.
//
// HOW IT WORKS
//   1. Every POLL_INTERVAL_MS, query Gmail for recent messages from the GHL
//      notification sender that do NOT yet carry the relay label.
//   2. For each hit, CLAIM it by writing the label FIRST, then post to Discord.
//      The label is the durable ledger — it survives restarts and redeploys,
//      so a deploy mid-poll can never double-post a code. (In-memory Sets die
//      on deploy; a Gmail label does not.)
//   3. Only codes newer than RELAY_MAX_AGE_MS are actually posted. Anything
//      older is labeled silently. That makes first-boot safe: the ~2 years of
//      historical codes already in the mailbox get claimed, not dumped into
//      the channel.
//
// AUTH
//   Uses the installed-app OAuth client already consented for
//   support@studioaz.us with gmail.modify (the same credential the local Gmail
//   MCP server uses). It is deliberately NOT the Calendar refresh token in
//   GOOGLE_REFRESH_TOKEN — that one has no Gmail scope, and widening it would
//   mean re-consenting the Meet/Calendar integration.
//
// ENV
//   GMAIL_WORK_CLIENT_ID       OAuth client id     (required)
//   GMAIL_WORK_CLIENT_SECRET   OAuth client secret (required)
//   GMAIL_WORK_REFRESH_TOKEN   refresh token       (required)
//   DISCORD_LOGIN_CODE_WEBHOOK_URL  Discord channel webhook (required)
//   GHL_CODE_SENDER            override sender match (optional)
//   DISABLE_LOGIN_CODE_RELAY=1 opt out entirely

require("dotenv").config({ quiet: true });
const axios = require("axios");

const POLL_INTERVAL_MS = 10 * 1000; // front desk is waiting — poll fast
const STARTUP_GRACE_MS = 15 * 1000; // don't collide with deploy boot
const RELAY_MAX_AGE_MS = 10 * 60 * 1000; // older than this = claim, don't post
const RELAY_LABEL = "Relayed to Discord";

const SENDER =
  process.env.GHL_CODE_SENDER || "noreply@notif.onthebusinesscrm.com";
const SUBJECT = "Login security code";

const CLIENT_ID = process.env.GMAIL_WORK_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_WORK_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_WORK_REFRESH_TOKEN;
const WEBHOOK_URL = process.env.DISCORD_LOGIN_CODE_WEBHOOK_URL;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

let timerHandle = null;
let pollInFlight = false;
let cachedToken = null; // { token, expiresAt }
let cachedLabelId = null;

/* ------------------------------------------------------------------ auth */

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error(
      "Missing Gmail OAuth credentials (GMAIL_WORK_CLIENT_ID / _SECRET / _REFRESH_TOKEN)"
    );
  }

  const resp = await axios.post(
    "https://oauth2.googleapis.com/token",
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    },
    { headers: { "Content-Type": "application/json" }, timeout: 15_000 }
  );

  const token = resp.data?.access_token;
  if (!token) throw new Error("Gmail token exchange returned no access_token");

  cachedToken = {
    token,
    expiresAt: Date.now() + (resp.data.expires_in || 3600) * 1000,
  };
  return token;
}

function auth(token) {
  return { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 };
}

/* ----------------------------------------------------------------- label */

async function ensureLabelId(token) {
  if (cachedLabelId) return cachedLabelId;

  const list = await axios.get(`${GMAIL}/labels`, auth(token));
  const existing = (list.data?.labels || []).find((l) => l.name === RELAY_LABEL);
  if (existing) {
    cachedLabelId = existing.id;
    return cachedLabelId;
  }

  const created = await axios.post(
    `${GMAIL}/labels`,
    {
      name: RELAY_LABEL,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
    auth(token)
  );
  cachedLabelId = created.data?.id;
  if (!cachedLabelId) throw new Error("Could not create relay label");
  console.log(`[loginCodeRelay] created Gmail label "${RELAY_LABEL}"`);
  return cachedLabelId;
}

/* ---------------------------------------------------------------- parsing */

// Gmail returns bodies base64url-encoded, split across MIME parts. Walk the
// tree and prefer text/plain; fall back to text/html with tags stripped.
function extractBody(payload) {
  const decode = (data) =>
    Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8"
    );

  let plain = "";
  let html = "";

  (function walk(part) {
    if (!part) return;
    const data = part.body?.data;
    if (data) {
      if (part.mimeType === "text/plain") plain += decode(data);
      else if (part.mimeType === "text/html") html += decode(data);
    }
    (part.parts || []).forEach(walk);
  })(payload);

  if (plain.trim()) return plain;
  return html.replace(/<[^>]+>/g, " ");
}

/**
 * Pull the 6-digit code and the "signing in from ..." context line.
 * The email reads: "Your one time login code for logging into
 * app.onthebusinesscrm.com [tracking-link] is 818327."
 *
 * The tracking link is a long base64-ish blob that can contain digit runs, so
 * anchor on "is <code>" first and only fall back to a bare 6-digit match.
 */
function parseCode(body) {
  const anchored = body.match(/\bis\s+(\d{6})\b/);
  const code = anchored
    ? anchored[1]
    : (body.match(/(?:^|\s)(\d{6})(?=\s|\.|$)/) || [])[1] || null;

  const ctx = body.match(/You are signing in from ([^\n.]+)\./);
  return { code, context: ctx ? ctx[1].trim() : null };
}

/* --------------------------------------------------------------- discord */

async function postToDiscord({ code, context, receivedAt }) {
  const when = new Date(receivedAt).toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });

  await axios.post(
    WEBHOOK_URL,
    {
      // Plain content too, so it is one long-press copy on a phone.
      content: `**GHL login code: ${code}**`,
      embeds: [
        {
          title: "🔐 GHL Login Security Code",
          description: `## ${code}`,
          color: 0xc9a54e,
          fields: [
            {
              name: "Sign-in attempt",
              value: context || "Details not provided",
            },
            { name: "Email received", value: `${when} CT` },
          ],
          footer: {
            text: "Expires shortly. If nobody at the desk requested this, do not use it — someone else has the password.",
          },
        },
      ],
    },
    { timeout: 15_000 }
  );
}

/* ------------------------------------------------------------------ poll */

async function pollOnce({ dryRun = false } = {}) {
  const token = await getAccessToken();
  const labelId = await ensureLabelId(token);

  const query = [
    `from:${SENDER}`,
    `subject:"${SUBJECT}"`,
    "newer_than:1d",
    `-label:"${RELAY_LABEL}"`,
  ].join(" ");

  const search = await axios.get(
    `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=10`,
    auth(token)
  );

  const messages = search.data?.messages || [];
  if (!messages.length) return { checked: 0, relayed: 0 };

  let relayed = 0;

  // Oldest first, so if two codes land together they post in order.
  for (const { id } of messages.slice().reverse()) {
    const full = await axios.get(
      `${GMAIL}/messages/${id}?format=full`,
      auth(token)
    );
    const receivedAt = Number(full.data.internalDate);
    const { code, context } = parseCode(extractBody(full.data.payload));

    if (!code) {
      console.warn(`[loginCodeRelay] no code parsed from ${id} — labeling`);
    }

    const isFresh = Date.now() - receivedAt <= RELAY_MAX_AGE_MS;

    if (dryRun) {
      console.log(
        `[loginCodeRelay] DRY RUN ${id}: code=${code} fresh=${isFresh} ctx="${context}"`
      );
      continue;
    }

    // CLAIM FIRST. If the post below throws, or the process dies mid-flight,
    // the label is already written and we will not re-post the same code.
    await axios.post(
      `${GMAIL}/messages/${id}/modify`,
      { addLabelIds: [labelId] },
      auth(token)
    );

    if (!code || !isFresh) {
      console.log(
        `[loginCodeRelay] claimed ${id} without posting (${
          !code ? "unparseable" : "stale"
        })`
      );
      continue;
    }

    try {
      await postToDiscord({ code, context, receivedAt });
      relayed++;
      console.log(`[loginCodeRelay] ✅ relayed code from ${id} (${context})`);
    } catch (err) {
      // Fail closed: already claimed, so no retry storm. A barber who does not
      // see the code within a few seconds will just request a new one.
      console.error(
        `[loginCodeRelay] ❌ Discord post FAILED for ${id}:`,
        err.response?.status || "",
        err.message || err
      );
    }
  }

  return { checked: messages.length, relayed };
}

async function tick() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollOnce();
  } catch (err) {
    console.error(
      "[loginCodeRelay] poll failed:",
      err.response?.status || "",
      err.message || err
    );
  } finally {
    pollInFlight = false;
  }
}

/**
 * Start the relay. Idempotent — repeat calls are no-ops.
 */
function startLoginCodeRelay() {
  if (timerHandle) return;

  if (!WEBHOOK_URL) {
    console.warn(
      "[loginCodeRelay] DISCORD_LOGIN_CODE_WEBHOOK_URL not set — relay not started"
    );
    return;
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.warn(
      "[loginCodeRelay] Gmail OAuth env vars missing — relay not started"
    );
    return;
  }

  console.log(
    `[loginCodeRelay] starting — first poll in ${
      STARTUP_GRACE_MS / 1000
    }s, then every ${POLL_INTERVAL_MS / 1000}s`
  );
  setTimeout(() => {
    tick().catch(() => {});
    timerHandle = setInterval(() => {
      tick().catch(() => {});
    }, POLL_INTERVAL_MS);
  }, STARTUP_GRACE_MS);
}

module.exports = {
  startLoginCodeRelay,
  pollOnce,
  // Exported for tests.
  parseCode,
  extractBody,
};
