// googleMcpRoutes.js — read-only MCP gateway for Gmail / Drive / Calendar.
// Mounted at /google-mcp in app.js. Endpoint: POST /google-mcp/mcp
//
// Fronts six upstream MCP servers (gmail/gdrive/gcal × personal/work) behind one
// Streamable HTTP endpoint, so MCP clients that have no routing rules of their
// own (Cowork, Claude Desktop) can still tell the two Google accounts apart —
// the account is baked into every tool name, e.g. `gmail_work__search_emails`.
//
// SAFETY — this module shares a process with booking. It must never take that
// down, so:
//   * nothing throws at require() time; the router is returned synchronously
//   * upstreams initialize lazily on first authenticated request, never at boot
//   * missing/invalid config degrades to 503 on THIS route only — never exit()
//   * every handler is wrapped; a failed init is retried on the next request
//
// Writes are blocked at two layers (absent from tools/list, rejected in
// tools/call) unless GOOGLE_MCP_ALLOW_WRITES === "true". Leave it unset: the
// endpoint is internet-facing and guarded only by a shared secret.

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const router = express.Router();

const TOKEN = process.env.GOOGLE_MCP_TOKEN;
const ALLOW_WRITES = process.env.GOOGLE_MCP_ALLOW_WRITES === "true";

const CRED_ENV = {
  keys: "GCP_OAUTH_KEYS",
  gmail_personal: "GMAIL_CREDS_PERSONAL",
  gmail_work: "GMAIL_CREDS_WORK",
  gdrive_personal: "GDRIVE_CREDS_PERSONAL",
  gdrive_work: "GDRIVE_CREDS_WORK",
  gcal_personal: "GCAL_TOKEN_PERSONAL",
  gcal_work: "GCAL_TOKEN_WORK",
};

const WRITE_TOOLS = new Set([
  "send_email", "draft_email", "modify_email", "delete_email",
  "batch_modify_emails", "batch_delete_emails", "create_label", "update_label",
  "delete_label", "get_or_create_label", "create_filter", "delete_filter",
  "create_filter_from_template", "download_attachment", "gsheets_update_cell",
  "create-event", "create-events", "update-event", "delete-event",
  "respond-to-event", "manage-accounts",
]);

const state = { ready: false, initPromise: null, tools: [], index: new Map(), clients: new Map() };

function missingEnv() {
  return Object.values(CRED_ENV).filter((n) => !process.env[n]);
}

async function init() {
  // MCP SDK is ESM-only; this file is CommonJS. Dynamic import bridges that.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmcp-"));
  fs.chmodSync(dir, 0o700);
  const write = (rel, envName) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
    fs.writeFileSync(full, process.env[envName], { mode: 0o600 });
    return full;
  };

  const keys = write("gcp-oauth.keys.json", CRED_ENV.keys);
  const oauth = JSON.parse(fs.readFileSync(keys, "utf8")).installed;
  const bin = (pkg, rel) => require.resolve(`${pkg}/${rel}`);

  const upstreams = [];
  for (const acct of ["personal", "work"]) {
    const gmailCreds = write(`gmail-${acct}.json`, CRED_ENV[`gmail_${acct}`]);
    write(`gdrive-${acct}/.gdrive-server-credentials.json`, CRED_ENV[`gdrive_${acct}`]);
    fs.copyFileSync(keys, path.join(dir, `gdrive-${acct}`, "gcp-oauth.keys.json"));
    const gcalToken = write(`gcal-${acct}.json`, CRED_ENV[`gcal_${acct}`]);

    upstreams.push(
      { name: `gmail_${acct}`, script: bin("@gongrzhe/server-gmail-autoauth-mcp", "dist/index.js"),
        env: { GMAIL_OAUTH_PATH: keys, GMAIL_CREDENTIALS_PATH: gmailCreds } },
      { name: `gdrive_${acct}`, script: bin("@isaacphi/mcp-gdrive", "dist/index.js"),
        env: { CLIENT_ID: oauth.client_id, CLIENT_SECRET: oauth.client_secret,
               GDRIVE_CREDS_DIR: path.join(dir, `gdrive-${acct}`) } },
      { name: `gcal_${acct}`, script: bin("@cocal/google-calendar-mcp", "build/index.js"),
        env: { GOOGLE_OAUTH_CREDENTIALS: keys, GOOGLE_CALENDAR_MCP_TOKEN_PATH: gcalToken } },
    );
  }

  const tools = [], index = new Map(), clients = new Map();
  for (const u of upstreams) {
    try {
      const c = new Client({ name: "setter-gateway", version: "1.0.0" }, { capabilities: {} });
      await c.connect(new StdioClientTransport({
        command: process.execPath, args: [u.script], env: { ...process.env, ...u.env },
      }));
      clients.set(u.name, c);
      const listed = await c.listTools();
      let n = 0;
      for (const t of listed.tools) {
        if (!ALLOW_WRITES && WRITE_TOOLS.has(t.name)) continue;
        const name = `${u.name}__${t.name}`.replace(/-/g, "_");
        index.set(name, { prefix: u.name, original: t.name });
        tools.push({ name, description: `[${u.name.replace("_", " / ")}] ${t.description || ""}`.trim(),
                     inputSchema: t.inputSchema });
        n++;
      }
      console.log(`✅ [GOOGLE-MCP] ${u.name}: ${n} tools`);
    } catch (err) {
      console.error(`❌ [GOOGLE-MCP] ${u.name} failed:`, err.message);
    }
  }
  if (!clients.size) throw new Error("no upstream MCP servers connected");

  state.tools = tools; state.index = index; state.clients = clients; state.ready = true;
  console.log(`✅ [GOOGLE-MCP] ready — ${tools.length} tools, writes ${ALLOW_WRITES ? "ALLOWED" : "blocked"}`);
}

function ensureReady() {
  if (state.ready) return Promise.resolve();
  if (!state.initPromise) {
    state.initPromise = init().catch((err) => {
      state.initPromise = null;          // let a later request retry
      throw err;
    });
  }
  return state.initPromise;
}

async function buildServer() {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");

  const s = new Server({ name: "studio-az-google-gateway", version: "1.0.0" },
                       { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: state.tools }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const entry = state.index.get(req.params.name);
    if (!entry) throw new Error(`Unknown tool: ${req.params.name}`);
    if (!ALLOW_WRITES && WRITE_TOOLS.has(entry.original)) {
      throw new Error("Write tools are disabled on this gateway.");
    }
    const client = state.clients.get(entry.prefix);
    if (!client) throw new Error(`Upstream unavailable: ${entry.prefix}`);
    return client.callTool({ name: entry.original, arguments: req.params.arguments ?? {} });
  });
  return s;
}

// Shared-secret auth. 403 (not 401) so MCP clients don't misread this as an
// OAuth-protected server and start a discovery flow.
router.use((req, res, next) => {
  if (!TOKEN || TOKEN.length < 32) {
    console.error("❌ [GOOGLE-MCP] GOOGLE_MCP_TOKEN unset or too short — route disabled");
    return res.status(503).json({ error: "gateway not configured" });
  }
  const hdr = req.headers.authorization || "";
  const got = (req.headers["x-gateway-token"] || "").toString()
    || (hdr.startsWith("Bearer ") ? hdr.slice(7) : "");
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.error(`❌ [GOOGLE-MCP] auth fail ${req.ip} ${req.method} ${req.path}`);
    return res.status(403).json({ error: "forbidden" });
  }
  next();
});

router.get("/status", async (req, res) => {
  const missing = missingEnv();
  res.json({
    ready: state.ready,
    tools: state.tools.length,
    upstreams: [...state.clients.keys()],
    writesAllowed: ALLOW_WRITES,
    missingEnv: missing,
  });
});

const sessions = new Map();
router.all("/mcp", async (req, res) => {
  try {
    const missing = missingEnv();
    if (missing.length) {
      console.error("❌ [GOOGLE-MCP] missing env:", missing.join(", "));
      return res.status(503).json({ error: "gateway not configured", missingEnv: missing });
    }
    await ensureReady();

    const sid = req.headers["mcp-session-id"];
    let transport = sid && sessions.get(sid);
    if (!transport) {
      const { StreamableHTTPServerTransport } =
        await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      const server = await buildServer();
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("❌ [GOOGLE-MCP] request error:", err.message);
    if (!res.headersSent) res.status(503).json({ error: "gateway unavailable" });
  }
});

module.exports = router;
