// buildingNoticeRelay.js
//
// Relays building-manager announcements (Susan Schmid, Union Plaza) into
// Discord so the shop sees closures, food trucks, outages and treats without
// the owner relaying them by hand.
//
// THE SAFETY PROBLEM THIS SOLVES
//   Susan sends two very different kinds of email from the same address:
//
//     BROADCAST  To: <empty>  — Bcc'd to every tenant in the building.
//                Food trucks, holiday closures, power outages, blood drives.
//                She already sent it to hundreds of people; by construction it
//                cannot contain anything private to Studio AZ.
//
//     DIRECT     To: chavezctz@gmail.com — a 1:1 email to the owner.
//                Historically: door keys, login credentials, the building
//                security system, tenant access lists, parking disputes.
//                NEVER safe to put in a channel the barbers can read.
//
//   Keyword or AI classification of prose would misfire in both directions and
//   the failure is irreversible — once it is in Discord the barbers have read
//   it, and deleting the message does not unring it. So this does not classify
//   content at all. It uses the STRUCTURAL fact of who the mail was addressed
//   to, which Susan's own send behaviour already encodes.
//
// WHAT POSTS
//   1. A genuine broadcast: from Susan AND the To: header does not name the
//      owner's personal address. Posts automatically.
//   2. Anything explicitly labeled APPROVAL_LABEL by the owner. This is the
//      manual override for a direct email he decides is worth sharing —
//      applying the label IS the approval. Default is deny.
//
//   Everything else is claimed and ignored. Fails closed on missing headers.
//
// ENV
//   GMAIL_WORK_*                    same credential as the login code relay
//   DISCORD_BUILDING_WEBHOOK_URL    channel for building notices (required)
//   BUILDING_MANAGER_SENDER         default sschmid@minikahda.com
//   OWNER_PERSONAL_EMAIL            default chavezctz@gmail.com
//   DISABLE_BUILDING_NOTICE_RELAY=1 opt out

require("dotenv").config({ quiet: true });
const axios = require("axios");
const { extractBody } = require("./ghlLoginCodeRelay");

const POLL_INTERVAL_MS = 60 * 1000; // announcements, not 2FA — 60s is plenty
const STARTUP_GRACE_MS = 20 * 1000;
const RELAY_MAX_AGE_MS = 6 * 60 * 60 * 1000; // don't post a backlog on boot
const RELAY_LABEL = "Relayed to Discord"; // shared ledger with the code relay
const APPROVAL_LABEL = "Post to Discord"; // owner applies this to approve

const SENDER = (
  process.env.BUILDING_MANAGER_SENDER || "sschmid@minikahda.com"
).toLowerCase();
const OWNER_PERSONAL = (
  process.env.OWNER_PERSONAL_EMAIL || "chavezctz@gmail.com"
).toLowerCase();

const CLIENT_ID = process.env.GMAIL_WORK_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_WORK_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_WORK_REFRESH_TOKEN;
const WEBHOOK_URL = process.env.DISCORD_BUILDING_WEBHOOK_URL;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

let timerHandle = null;
let pollInFlight = false;
let cachedToken = null;
const labelIds = {};

/* ------------------------------------------------------------------ auth */

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
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

const auth = (token) => ({
  headers: { Authorization: `Bearer ${token}` },
  timeout: 15_000,
});

async function ensureLabelId(token, name) {
  if (labelIds[name]) return labelIds[name];
  const list = await axios.get(`${GMAIL}/labels`, auth(token));
  const found = (list.data?.labels || []).find((l) => l.name === name);
  if (found) {
    labelIds[name] = found.id;
    return found.id;
  }
  const created = await axios.post(
    `${GMAIL}/labels`,
    {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
    auth(token)
  );
  labelIds[name] = created.data?.id;
  if (!labelIds[name]) throw new Error(`Could not create label ${name}`);
  console.log(`[buildingRelay] created Gmail label "${name}"`);
  return labelIds[name];
}

/* -------------------------------------------------------------- decision */

function header(payload, name) {
  const h = (payload?.headers || []).find(
    (x) => x.name.toLowerCase() === name.toLowerCase()
  );
  return h ? h.value || "" : "";
}

/**
 * A broadcast is mail Susan Bcc'd to the whole building: the To: header does
 * not name the owner personally. If To: names him, it is a direct 1:1 email
 * and must never auto-post, whatever it says.
 */
function isBroadcast(payload) {
  const from = header(payload, "from").toLowerCase();
  if (!from.includes(SENDER)) return false;

  const to = header(payload, "to").toLowerCase();
  const cc = header(payload, "cc").toLowerCase();
  return !to.includes(OWNER_PERSONAL) && !cc.includes(OWNER_PERSONAL);
}

/** Collapse quoted replies, signature and whitespace into something postable. */
function cleanBody(raw) {
  let text = (raw || "").replace(/\r/g, "");

  // Drop everything from the first quoted-reply marker onward.
  const cut = text.search(/^\s*(On .+ wrote:|-{2,}\s*Original Message|From:\s)/m);
  if (cut > 0) text = text.slice(0, cut);

  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, a) => l || (i > 0 && a[i - 1])) // squeeze blank runs
    .join("\n")
    .trim();
}

/* --------------------------------------------------------------- discord */

async function postToDiscord({ subject, body, receivedAt, approved }) {
  const when = new Date(receivedAt).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  let description = body || "(no text content)";
  if (description.length > 3800) description = description.slice(0, 3800) + "\n…";

  await axios.post(
    WEBHOOK_URL,
    {
      embeds: [
        {
          title: `🏢 ${subject || "(no subject)"}`.slice(0, 250),
          description,
          color: 0x4e7ec9,
          footer: {
            text: approved
              ? `Union Plaza · Susan Schmid · shared by Lionel · ${when} CT`
              : `Union Plaza · Susan Schmid · ${when} CT`,
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
  const ledgerId = await ensureLabelId(token, RELAY_LABEL);
  const approvalId = await ensureLabelId(token, APPROVAL_LABEL);

  const query = [
    `(from:${SENDER} OR label:"${APPROVAL_LABEL}")`,
    "newer_than:3d",
    `-label:"${RELAY_LABEL}"`,
  ].join(" ");

  const search = await axios.get(
    `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=15`,
    auth(token)
  );
  const messages = search.data?.messages || [];
  if (!messages.length) return { checked: 0, relayed: 0 };

  let relayed = 0;

  for (const { id } of messages.slice().reverse()) {
    const full = await axios.get(
      `${GMAIL}/messages/${id}?format=full`,
      auth(token)
    );
    const payload = full.data.payload;
    const receivedAt = Number(full.data.internalDate);
    const subject = header(payload, "subject");

    const approved = (full.data.labelIds || []).includes(approvalId);
    const broadcast = isBroadcast(payload);
    const isFresh = Date.now() - receivedAt <= RELAY_MAX_AGE_MS;
    const shouldPost = (broadcast || approved) && isFresh;

    if (dryRun) {
      console.log(
        `[buildingRelay] DRY RUN "${subject}" broadcast=${broadcast} approved=${approved} fresh=${isFresh} -> ${
          shouldPost ? "POST" : "SKIP"
        }`
      );
      continue;
    }

    // Claim first — the label is the ledger that survives redeploys.
    await axios.post(
      `${GMAIL}/messages/${id}/modify`,
      { addLabelIds: [ledgerId] },
      auth(token)
    );

    if (!shouldPost) {
      const why = !isFresh
        ? "stale"
        : "direct to owner — not a broadcast, not approved";
      console.log(`[buildingRelay] claimed "${subject}" without posting (${why})`);
      continue;
    }

    try {
      await postToDiscord({
        subject,
        body: cleanBody(extractBody(payload)),
        receivedAt,
        approved: approved && !broadcast,
      });
      relayed++;
      console.log(
        `[buildingRelay] ✅ relayed "${subject}" (${
          broadcast ? "broadcast" : "owner-approved"
        })`
      );
    } catch (err) {
      console.error(
        `[buildingRelay] ❌ Discord post FAILED for "${subject}":`,
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
      "[buildingRelay] poll failed:",
      err.response?.status || "",
      err.message || err
    );
  } finally {
    pollInFlight = false;
  }
}

function startBuildingNoticeRelay() {
  if (timerHandle) return;
  if (!WEBHOOK_URL) {
    console.warn(
      "[buildingRelay] DISCORD_BUILDING_WEBHOOK_URL not set — relay not started"
    );
    return;
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.warn("[buildingRelay] Gmail OAuth env vars missing — relay not started");
    return;
  }
  console.log(
    `[buildingRelay] starting — first poll in ${
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
  startBuildingNoticeRelay,
  pollOnce,
  isBroadcast,
  cleanBody,
};
