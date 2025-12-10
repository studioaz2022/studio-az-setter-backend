const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const Square = require('square');
const { v4: uuidv4 } = require('uuid');
const { createGoogleMeet } = require('./tools/google_meet');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  if (req.path.startsWith('/webhooks/')) {
    console.log(`[WB] ${req.method} ${req.path} len=${Buffer.byteLength(JSON.stringify(req.body || {}))}`);
  }
  next();
});
const PORT = process.env.PORT || 3000;

const path = require('path');
app.use(
  '/.well-known',
  express.static(path.join(__dirname, 'public', '.well-known'), {
    dotfiles: 'allow',
    etag: false,
    maxAge: '0'
  })
);


if (process.env.ALLOW_DEBUG === 'true') {
  // 3a) Live charge endpoint (will optionally auto-refund)
  app.post('/debug/pay-live', async (req, res) => {
    try {
      const { sourceId, amount = 100, note = 'prod smoke test', autoRefund = true } = req.body || {};
      if (!sourceId) return res.status(400).json({ ok:false, error:'sourceId required' });

      const pay = await createSquarePayment({
        sourceId,
        amount,                      // cents, e.g. 100 = $1.00
        locationId: SQUARE_LOCATION_ID,
        note
      });

      const paymentId = pay?.payment?.id;
      const out = { ok:true, paymentId, status: pay?.payment?.status };

      if (autoRefund && paymentId) {
        try {
          await refundSquarePayment({ paymentId, amount });
          out.refunded = true;
        } catch (e) {
          out.refunded = false;
          out.refundError = e?.response?.data || e.message;
        }
      }

      res.json(out);
    } catch (e) {
      res.status(400).json({ ok:false, error: e?.response?.data || e.message });
    }
  });

  // 3b) One-off HTML page to tokenize a real card in PRODUCTION
  app.get('/test-pay', (_req, res) => {
    res.type('html').send(`
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Square Prod Smoke Test</title></head>
<body>
  <h3>Square Production $1 Smoke Test</h3>
  <div id="card"></div>
  <button id="payBtn">Pay $1</button>
  <pre id="out"></pre>

  <script src="https://web.squarecdn.com/v1/square.js"></script>
  <script>
    (async () => {
      const cfg = await (await fetch('/public-config')).json();
      const payments = window.Square.payments(cfg.applicationId, cfg.locationId);
      const card = await payments.card();
      await card.attach('#card');

      const btn = document.getElementById('payBtn');
      const out = document.getElementById('out');

      btn.onclick = async () => {
        btn.disabled = true;
        out.textContent = 'Tokenizing…';
        const { status, token } = await card.tokenize();
        if (status !== 'OK') { out.textContent = 'Tokenize failed: ' + status; btn.disabled = false; return; }
        out.textContent = 'Charging…';
        const resp = await fetch('/debug/pay-live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId: token, amount: 100, autoRefund: true })
        });
        const data = await resp.json();
        out.textContent = JSON.stringify(data, null, 2);
        btn.disabled = false;
      };
    })();
  </script>
</body>
</html>`);
  });
}

// --- Initialize Square Client (works with multiple SDK shapes) ---

const Client       = Square.Client        || Square.SquareClient;
const Environment  = Square.Environment   || Square.SquareEnvironment;

// Allow SQUARE_ENV=production|sandbox to override; fallback to NODE_ENV
const SQUARE_ENV = (process.env.SQUARE_ENV || '').toLowerCase();
const isProduction = SQUARE_ENV ? SQUARE_ENV === 'production'
                                : process.env.NODE_ENV === 'production';

const SQUARE_LOCATION_ID = isProduction
  ? process.env.SQUARE_PRODUCTION_LOCATION_ID
  : process.env.SQUARE_SANDBOX_LOCATION_ID;

const SQUARE_APP_ID = isProduction
  ? process.env.SQUARE_PRODUCTION_APPLICATION_ID
  : process.env.SQUARE_SANDBOX_APPLICATION_ID;

if (!SQUARE_APP_ID) {
  console.error('Missing SQUARE_*_APPLICATION_ID in .env (must match the SAME app as your access token)');
}


const squareClient = new Client({
  environment: isProduction ? Environment.Production : Environment.Sandbox,
  accessToken: isProduction
    ? process.env.SQUARE_PRODUCTION_ACCESS_TOKEN
    : process.env.SQUARE_SANDBOX_ACCESS_TOKEN,
});

console.log(`Server running in ${isProduction ? 'PRODUCTION' : 'SANDBOX'} mode.`);

// --- CREDENTIALS CHECK ---
console.log('--- CREDENTIALS CHECK ---');
const activeToken = isProduction
  ? process.env.SQUARE_PRODUCTION_ACCESS_TOKEN
  : process.env.SQUARE_SANDBOX_ACCESS_TOKEN;
console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`SQUARE_LOCATION_ID being used: ${SQUARE_LOCATION_ID}`);
console.log(`SQUARE_ACCESS_TOKEN ending in: ...${activeToken ? activeToken.slice(-6) : 'UNDEFINED'}`);

// Correctly define ghlKey before using it
const ghlKey = process.env.GHL_API_KEY;
console.log(`GHL_API_KEY ending in: ...${ghlKey ? ghlKey.slice(-6) : 'UNDEFINED'}`);

console.log('-------------------------');

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'mUemx2jG4wly4kJWBkI4'; // fallback to your known location
if (!GHL_LOCATION_ID) console.warn('Missing GHL_LOCATION_ID in .env');

// Build the required headers for GHL/LeadConnector calls (calendar endpoints need LocationId)
function ghlHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
    LocationId: GHL_LOCATION_ID, // <-- THIS FIXES THE 403
  };
}


// --- END DEBUGGING BLOCK ---

// Normalize API accessors across SDK builds (includes underscored props)
const SQ = {
  payments:  squareClient.paymentsApi  || squareClient.payments  || squareClient._payments,
  refunds:   squareClient.refundsApi   || squareClient.refunds   || squareClient._refunds,
  locations: squareClient.locationsApi || squareClient.locations || squareClient._locations
};

console.log('Square SDK shape note:',
  !squareClient.locationsApi ? 'locationsApi not found, using legacy/underscore if present.' : 'locationsApi ok.',
  'Client keys:', Object.keys(squareClient)
);
// Make sure Payments API is available
if (!SQ.payments || typeof SQ.payments.createPayment !== 'function') {
  console.error('Square SDK: payments.createPayment not found. Available keys on SQ.payments:',
    SQ.payments ? Object.keys(SQ.payments) : '(none)'
  );
}


// Optional: quick sanity log if something is missing
if (!SQ.locations?.listLocations) {
  console.warn(
    'Square SDK shape note: locationsApi not found, using legacy locations object if present.',
    'Client keys:', Object.keys(squareClient)
  );
}

// --- Square HTTP fallback (bypass broken SDK) ---
const SQUARE_ACCESS_TOKEN = isProduction
  ? process.env.SQUARE_PRODUCTION_ACCESS_TOKEN
  : process.env.SQUARE_SANDBOX_ACCESS_TOKEN;

const SQUARE_BASE_URL = isProduction
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

// Use a recent stable API version
const SQUARE_API_VERSION = '2024-08-21';

async function squarePost(path, payload) {
  return axios.post(`${SQUARE_BASE_URL}${path}`, payload, {
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_API_VERSION,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
}

// Simple GET wrapper
async function squareGet(path) {
  return axios.get(`${SQUARE_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_API_VERSION
    },
    timeout: 15000
  });
}

// List locations using HTTP (confirms the access token's merchant + locations)
app.get('/debug/http-locations', async (_req, res) => {
  try {
    const { data } = await squareGet('/v2/locations');
    res.json({ ok: true, locations: data.locations || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || String(e) });
  }
});

// Show merchant tied to your access token (helps confirm you’re on the right app/account)
app.get('/debug/http-merchant', async (_req, res) => {
  try {
    const { data } = await squareGet('/v2/merchants');
    res.json({ ok: true, merchants: data.merchants || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || String(e) });
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));


// DEBUG: inspect events by calendarId OR userId
app.get('/debug/ghl-events', async (req, res) => {
  try {
    const { calendarId, userId, hours = '24' } = req.query;
    if (!calendarId && !userId) {
      return res.status(400).json({ ok: false, error: 'calendarId or userId is required' });
    }

    const now = new Date(); now.setMinutes(0, 0, 0);
    const startMs = now.getTime();
    const endMs   = startMs + Number(hours) * 60 * 60 * 1000;

    const params = new URLSearchParams({
      locationId: GHL_LOCATION_ID,
      startTime: String(startMs),
      endTime:   String(endMs),
    });
    if (calendarId) params.set('calendarId', calendarId);
    if (userId)     params.set('userId', userId);

    const url = `https://services.leadconnectorhq.com/calendars/events?${params.toString()}`;
    console.log(`[GHL-DEBUG] GET ${url}`);
    const { data, status } = await axios.get(url, { headers: ghlHeaders(process.env.GHL_API_KEY) });

    res.json({
      ok: true,
      status,
      count: (data?.events || []).length,
      sample: (data?.events || []).slice(0, 3),
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const payload = e?.response?.data || { message: e.message };
    console.error('[GHL-DEBUG] error:', payload);
    res.status(status).json({ ok: false, status, error: payload });
  }
});




// Create payment via raw REST (snake_case per Square HTTP API)
async function createSquarePayment({ sourceId, amount, locationId, note }) {
  const payload = {
    source_id: sourceId,
    idempotency_key: uuidv4(),
    amount_money: { amount, currency: 'USD' },
    location_id: locationId,
    autocomplete: true,
    note
  };
  const { data } = await squarePost('/v2/payments', payload);
  return data; // => { payment: {...} }
}

// Refund via raw REST
async function refundSquarePayment({ paymentId, amount }) {
  const payload = {
    idempotency_key: uuidv4(),
    payment_id: paymentId,
    amount_money: { amount, currency: 'USD' }
  };
  const { data } = await squarePost('/v2/refunds', payload);
  return data; // => { refund: {...} }
}

// (optional) debug route to verify your Square token/locations
app.get('/debug/square-locations', async (_req, res) => {
  try {
    if (!SQ.locations || typeof SQ.locations.listLocations !== 'function') {
      return res.json({
        ok: true,
        note: 'Locations API not available in this SDK build. That’s fine—payments/refunds still work.'
      });
    }
    const resp = await SQ.locations.listLocations();
    const locations = resp.result?.locations || resp.locations || [];
    const out = locations.map(l => ({
      id: l.id, name: l.name, status: l.status, type: l.type, timezone: l.timezone
    }));
    res.json(out);
  } catch (e) {
    console.error('listLocations failed:', e?.body || e);
    res.status(500).json(e?.body || { error: e.message || 'failed to list locations' });
  }
});

// Public config for the frontend to fetch (so App ID & Location ID always match server creds)
app.get('/public-config', (_req, res) => {
  res.json({
    env: isProduction ? 'production' : 'sandbox',
    applicationId: SQUARE_APP_ID,
    locationId: SQUARE_LOCATION_ID,
  });
});

app.get('/debug/identity', (_req, res) => {
  const tok = isProduction ? process.env.SQUARE_PRODUCTION_ACCESS_TOKEN : process.env.SQUARE_SANDBOX_ACCESS_TOKEN;
  res.json({
    env: isProduction ? 'production' : 'sandbox',
    baseUrl: SQUARE_BASE_URL,
    squareVersion: SQUARE_API_VERSION,
    applicationId: SQUARE_APP_ID,
    locationId: SQUARE_LOCATION_ID,
    accessToken_tail: tok ? tok.slice(-6) : '(missing)',
  });
});

app.post('/debug/pay-test', async (_req, res) => {
  try {
    const data = await createSquarePayment({
      sourceId: 'cnon:card-nonce-ok',   // special sandbox test nonce
      amount: 100,                      // $1.00
      locationId: SQUARE_LOCATION_ID,
      note: 'server-only test payment'
    });
    return res.json({ ok: true, paymentId: data.payment?.id || null });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.response?.data || e });
  }
});



// --- ARTIST CONFIGURATION MAP ---
const artistConfig = {
  joan: {
    inPerson: process.env.ARTIST_1_IN_PERSON_ID,
    online: process.env.ARTIST_1_ONLINE_ID,
  },
  andrew: {
    inPerson: process.env.ARTIST_2_IN_PERSON_ID,
    online: process.env.ARTIST_2_ONLINE_ID,
  },
  claudia: {
    inPerson: process.env.ARTIST_3_IN_PERSON_ID,
    online: process.env.ARTIST_3_ONLINE_ID,
  }
};

const translatorConfig = {
    lionel: {
        inPerson: process.env.TRANSLATOR_1_IN_PERSON_ID,
        online: process.env.TRANSLATOR_1_ONLINE_ID,
    },
    maria: {
        inPerson: process.env.TRANSLATOR_2_IN_PERSON_ID,
        online: process.env.TRANSLATOR_2_ONLINE_ID,
    }
}


// --- Helper Functions ---
const getSlotsForCalendar = async (apiKey, calendarId) => {
  if (!calendarId) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = today.getTime();
  const endDate = startDate + 30 * 24 * 60 * 60 * 1000;

  const apiUrl = `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?startDate=${startDate}&endDate=${endDate}`;

  try {
    const response = await axios.get(apiUrl, { headers: ghlHeaders(apiKey) });
    let allSlots = [];
    for (const date in response.data) {
      if (response.data[date].slots) {
        allSlots = allSlots.concat(response.data[date].slots);
      }
    }
    return allSlots;
  } catch (error) {
    console.error(`Failed to fetch slots for calendar ${calendarId}:`,
      error.response ? error.response.data : error.message);
    return [];
  }
};

const getTodaysAppointments = async (apiKey, calendarId) => {
  if (!calendarId) return null; // "unknown"
  const today = new Date(); today.setHours(0,0,0,0);
  const startMs = today.getTime();
  const endMs   = startMs + 24*60*60*1000;

  const url = `https://services.leadconnectorhq.com/calendars/events`
            + `?locationId=${GHL_LOCATION_ID}`
            + `&calendarId=${calendarId}`
            + `&startTime=${startMs}`
            + `&endTime=${endMs}`;

  try {
    const { data } = await axios.get(url, { headers: ghlHeaders(apiKey) });
    return data.events || [];
  } catch (error) {
    const status = error?.response?.status;
    if (status === 401 || status === 403 || status === 404) {
      console.warn(`Workload probe skipped for ${calendarId}: ${status}`);
      return null; // treat as unknown, keep fallback
    }
    console.error(`Failed to fetch appointments for ${calendarId}:`,
      error.response ? error.response.data : error.message);
    return null;
  }
};

// UPDATE or CREATE an Opportunity for a Contact in GHL //
const ghl = axios.create({
  baseURL: process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com',
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.GHL_API_TOKEN}`
  },
});

function computeDepositUSD(answers, experience) {
  // Prefer explicit fields; fallback to generic `size`
  const raw = answers?.q_tattoo_size || answers?.q_tatuaje_tamano || answers?.size || '';
  const s = String(raw).toLowerCase();

  // Treat common “medium/large/mediano/grande/sleeve/full” as high tier
  const high = ['medium','large','mediano','grande','half','full','media','manga','sleeve','espalda','pecho'];
  const isHigh = high.some(w => s.includes(w));

  // Rule: high → $100, otherwise $50
  return isHigh ? 100 : 50;
}


async function upsertOpportunityForContact({
  contactId,
  pipelineId,
  stageId,
  monetaryValue, // number in USD
  name,          // string
  assignedUserId // optional
}) {
  // 1) Try to find an existing open opp for this contact in this pipeline
  const searchParams = new URLSearchParams({
    contactId,
    pipelineId,
    page: '1',
    limit: '1',
    status: 'open'
  }).toString();

  let existing = null;
  try {
    const { data } = await ghl.get(`/opportunities?${searchParams}`);
    if (Array.isArray(data?.opportunities) && data.opportunities.length) {
      existing = data.opportunities[0];
    }
  } catch (e) {
    console.warn('[GHL] list opportunities failed (non-fatal):', e?.response?.data || e.message);
  }

  const payload = {
    contactId,
    pipelineId,
    pipelineStageId: stageId,
    monetaryValue,
    status: 'open',
    name,
    ...(assignedUserId ? { assignedUserId } : {})
  };

  try {
    if (existing) {
      // Update existing
      const { data } = await ghl.put(`/opportunities/${existing.id}`, payload);
      return data;
    } else {
      // Create new
      const { data } = await ghl.post('/opportunities/', payload);
      return data;
    }
  } catch (e) {
    console.error('[GHL] upsert opportunity failed:', e?.response?.data || e.message);
    throw e;
  }
}


// --- CANCEL HELPERS (prefer status update over delete) ---

// Try to mark an appointment as cancelled WITHOUT deleting it.
// We send a rich payload because some clusters require start/end/etc.
// IMPORTANT: we no longer send `status`, only `appointmentStatus`,
// because your cluster 422'd on `status`.
async function cancelSoft(ev, headers) {
  const eventId    = ev.id;
  const calendarId = ev.calendarId;

  // We'll build the payload field-by-field and only include things
  // if we actually have values. This avoids GHL choking on "undefined".
  const body = {
    calendarId,
    locationId: GHL_LOCATION_ID,

    // timing (required by some clusters)
    startTime: ev.startTime,
    endTime:   ev.endTime,

    // title / description context
    title: ev.title || ev.name || 'Consultation',
    description: ev.description || ev.notes || '',

    // mark cancelled in the field GHL workflows actually key off of
    appointmentStatus: 'cancelled',

    // keep the same owner if present
    assignedUserId: ev.assignedUserId || ev.userId || undefined,

    // meeting / join info if it existed
    meetingLocationType: ev.meetingLocationType || 'custom',
    meetingLocationId:   ev.meetingLocationId   || 'custom_0',
    address:             ev.address || ev.location || undefined,

    // flags to make the API more permissive
    toNotify: false,                    // don't spam reminders
    ignoreFreeSlotValidation: true,     // allow moving without checking slot
    overrideLocationConfig: true        // avoid "use default calendar settings" errors
  };

  // clean out any undefined keys (GHL sometimes hates undefined/null)
  Object.keys(body).forEach((k) => {
    if (body[k] === undefined || body[k] === null) {
      delete body[k];
    }
  });

  try {
    // Primary / documented endpoint
    const url1 = `https://services.leadconnectorhq.com/calendars/events/appointments/${encodeURIComponent(eventId)}`;
    await axios.put(url1, body, { headers });
    return { ok: true, method: 'appointments.put' };
  } catch (e1) {
    // Fallback legacy endpoint. Your logs showed 401, but we’ll keep it
    // just in case other environments allow it.
    try {
      const url2 = `https://services.leadconnectorhq.com/calendars/events/${encodeURIComponent(eventId)}`;
      await axios.put(url2, body, { headers });
      return { ok: true, method: 'events.put' };
    } catch (e2) {
      return {
        ok: false,
        errors: [
          e1?.response?.data || e1.message,
          e2?.response?.data || e2.message
        ]
      };
    }
  }
}

// Try to reschedule a sibling appointment to match the new time.
// We DO NOT mark it cancelled, we just update start/end/etc.
async function rescheduleSibling(ev, headers, newStart, newEnd) {
  const eventId    = ev.id;
  const calendarId = ev.calendarId;

  // Build payload using the sibling's existing data so GHL
  // doesn't yell about missing required fields.
  const body = {
    calendarId,
    locationId: GHL_LOCATION_ID,

    // new requested time
    startTime: newStart,
    endTime:   newEnd,

    // keep status as-is
    appointmentStatus: ev.appointmentStatus || ev.status || 'confirmed',

    // keep who it's assigned to
    assignedUserId: ev.assignedUserId || ev.userId || undefined,

    // keep title/description the same
    title: ev.title || ev.name || 'Consultation',
    description: ev.description || ev.notes || '',

    // preserve meeting/join info if it exists
    meetingLocationType: ev.meetingLocationType || 'custom',
    meetingLocationId:   ev.meetingLocationId   || 'custom_0',
    address:             ev.address || ev.location || undefined,

    // make API more permissive
    toNotify: false,                    // don't blast notifications
    ignoreFreeSlotValidation: true,     // allow "move" even if slot is technically blocked
    overrideLocationConfig: true        // bypass strict calendar settings
  };

  // strip undefined/null keys so GHL doesn't choke
  Object.keys(body).forEach(k => {
    if (body[k] === undefined || body[k] === null) {
      delete body[k];
    }
  });

  try {
    // Main (appointments) endpoint
    const url1 = `https://services.leadconnectorhq.com/calendars/events/appointments/${encodeURIComponent(eventId)}`;
    await axios.put(url1, body, { headers });
    return { ok: true, method: 'appointments.put' };
  } catch (e1) {
    // Fallback legacy endpoint (some clusters allow it, yours probably won't, but harmless)
    try {
      const url2 = `https://services.leadconnectorhq.com/calendars/events/${encodeURIComponent(eventId)}`;
      await axios.put(url2, body, { headers });
      return { ok: true, method: 'events.put' };
    } catch (e2) {
      return {
        ok: false,
        errors: [
          e1?.response?.data || e1.message,
          e2?.response?.data || e2.message
        ]
      };
    }
  }
}


// Normalize "VIP" -> "Reserve", keep "Signature" as-is
function normalizeExperience(raw) {
  const lower = String(raw || '').toLowerCase();
  if (lower === 'vip' || lower === 'reserve') {
    return 'Reserve';
  }
  return 'Signature';
}

// Build the title that goes on BOTH the artist + translator calendars.
// Example: "Signature Consulta📱: Jane Doe" or "Reserve Consultation🙋: Juan Perez"
function buildApptTitle({ lang, location, firstName, lastName, experienceLabel }) {
  const isSpanish = String(lang || '').toLowerCase().startsWith('span');
  const word = isSpanish ? 'Consulta' : 'Consultation';
  const icon = location === 'Online' ? '📱' : '🙋';

  // ex: "Signature Consulta📱: Jane Doe"
  return `${experienceLabel} ${word}${icon}: ${firstName} ${lastName}`;
}


// DEBUG: show which translator env IDs the server sees (don’t keep in prod long-term)
app.get('/debug/translator-env', (_req, res) => {
  res.json({
    TRANSLATOR_1_USER_ID: !!process.env.TRANSLATOR_1_USER_ID,
    TRANSLATOR_2_USER_ID: !!process.env.TRANSLATOR_2_USER_ID,
    valuesTail: {
      t1: process.env.TRANSLATOR_1_USER_ID ? process.env.TRANSLATOR_1_USER_ID.slice(-6) : null,
      t2: process.env.TRANSLATOR_2_USER_ID ? process.env.TRANSLATOR_2_USER_ID.slice(-6) : null,
    }
  });
});

app.get('/debug/google-meet-smoke', async (req, res) => {
  try {
    const startISO = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const endISO   = new Date(Date.now() + 35 * 60 * 1000).toISOString();

    const { meetUrl, htmlLink } = await createGoogleMeet({
      summary: 'Meet smoke test',
      description: 'Render test event from server',
      startISO,
      endISO,
      attendees: []
    });

    res.json({ ok: true, meetUrl, htmlLink });
  } catch (e) {
    console.error('meet-smoke failed:', e?.response?.data || e);
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});


// DEBUG: manually attach a follower to a contact to see API errors clearly
app.post('/debug/add-follower', async (req, res) => {
  try {
    const { contactId, userId } = req.body || {};
    if (!contactId || !userId) return res.status(400).json({ ok:false, error:'contactId and userId required' });
    const ok = await addContactFollower(process.env.GHL_API_KEY, contactId, userId);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.response?.data || e.message });
  }
});

app.use(cors({
  origin: [
    'https://www.tattooshopminneapolis.com',
    'https://tattooshopminneapolis.com',
    'https://studioaztattoo.com',
    'https://www.studioaztattoo.com',
    'https://onthebusinesscrm.com',
    'https://app.onthebusinesscrm.com'

  ],
  methods: ['GET','POST'],
  credentials: false
}));


// Query workload per assignedUserId
async function getWorkloadCountsByUser(apiKey, locationId, userIds, startMillis, endMillis) {
  const headers = ghlHeaders(apiKey);
  const counts = {};

  await Promise.all(userIds.map(async (uid) => {
    const url = `https://services.leadconnectorhq.com/calendars/events`
      + `?locationId=${locationId}`
      + `&userId=${encodeURIComponent(uid)}`
      + `&startTime=${startMillis}`
      + `&endTime=${endMillis}`;

    try {
      const { data } = await axios.get(url, { headers });
      const events = data?.events || [];
      let n = 0;
      for (const ev of events) {
        const status = String(ev.appointmentStatus || '').toLowerCase();
        if (['cancelled','canceled','no_show','noshow'].includes(status)) continue;
        n++;
      }
      counts[uid] = n;              // real workload for this user
    } catch (e) {
      const status = e?.response?.status;
      console.warn(`Workload read failed for userId ${uid}: ${status || ''} ${e?.response?.data?.message || e.message}`);
      counts[uid] = null;           // unknown → will fall back to 999 for that user only
    }
  }));

  return counts;
}


// === Artist userIds (for cross-calendar workload scoring) ===
const ARTIST_USER_IDS = {
  JOAN:    process.env.ARTIST_1_USER_ID,
  ANDREW:  process.env.ARTIST_2_USER_ID,
  CLAUDIA: process.env.ARTIST_3_USER_ID,
};

const TRANSLATOR_USER_IDS = {
  LIONEL:  process.env.TRANSLATOR_1_USER_ID,
  MARIA:   process.env.TRANSLATOR_2_USER_ID,
};

// Scoring window config
const APPT_SCORING_TZ = process.env.APPT_SCORING_TZ || 'America/Chicago';
const APPT_SCORING_WINDOW = (process.env.APPT_SCORING_WINDOW || 'day').toLowerCase();

// Rolling window in millis (least error-prone). 'day' = today (UTC midnight), 'week' = next 7 days
function computeWindowMillis() {
  if (APPT_SCORING_WINDOW === 'week') {
    const now = Date.now();
    return { startMillis: now, endMillis: now + 7 * 24 * 60 * 60 * 1000 };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return { startMillis: today.getTime(), endMillis: today.getTime() + 24 * 60 * 60 * 1000 };
}

// Pull all events for the Location in the time window (works even if individual calendar reads are blocked)
async function getLocationEvents(apiKey, locationId, startMillis, endMillis) {
  const url = `https://services.leadconnectorhq.com/calendars/events` +
              `?locationId=${locationId}&startTime=${startMillis}&endTime=${endMillis}`;
  const { data } = await axios.get(url, { headers: ghlHeaders(apiKey) });
  return data?.events || [];
}







// new: helper to refund on failures after payment capture
async function refundIfNeeded(paymentId, amount) {
  if (!paymentId) return;
  try {
    await refundSquarePayment({ paymentId, amount });
    console.log('Refund issued for', paymentId);
  } catch (e) {
    const full = e?.response?.data || e?.body || e;
    console.error('Refund failed (manual follow-up needed):', JSON.stringify(full, null, 2));
  }
}
async function listCalendarsForLocation(apiKey, locationId) {
  const headers = { ...ghlHeaders(apiKey), Accept: 'application/json' };

  const urls = [
    `https://services.leadconnectorhq.com/calendars?locationId=${locationId}`,
    `https://services.leadconnectorhq.com/calendars`
  ];

  for (const url of urls) {
    try {
      const { data } = await axios.get(url, { headers });
      const calendars = data.calendars || data || [];
      return { calendars, idSet: new Set(calendars.map(c => c.id)) };
    } catch (e) {
      const status = e?.response?.status;
      if (status === 404) continue;      // endpoint not available on this cluster
      throw e;                            // real error (401/403/5xx)
    }
  }

  // Neither endpoint exists, but other endpoints still work. Don't block.
  console.warn('Calendar list endpoint not available for this API key/cluster. Skipping visibility filter.');
  return { calendars: [], idSet: null };
}

// Assign the contact owner to a specific user (the Artist)
async function assignContactOwner(apiKey, contactId, userId, locationId) {
  const headers = { ...ghlHeaders(apiKey), Accept: 'application/json' };

  // Try the common endpoint
  try {
    await axios.post(
      'https://services.leadconnectorhq.com/contacts/assign',
      { contactId, userId, locationId },
      { headers }
    );
    console.log(`Contact ${contactId} assigned to user ${userId}`);
    return true;
  } catch (e) {
    const status = e?.response?.status;
    console.warn('contacts/assign failed, trying /contacts/{id}/assign…', status, e?.response?.data || e.message);
  }

  // Fallback shape (seen on some clusters)
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contactId}/assign`,
      { userId, locationId },
      { headers }
    );
    console.log(`Contact ${contactId} assigned to user ${userId} (fallback endpoint)`);
    return true;
  } catch (e) {
    console.warn('Owner assignment failed on both endpoints:', e?.response?.data || e.message);
    return false;
  }
}

// Add a follower (the Translator) to the same contact
async function addContactFollower(apiKey, contactId, userId) {
  const headers = {
    ...ghlHeaders(apiKey),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const url = `https://services.leadconnectorhq.com/contacts/${contactId}/followers`;
  const body = { followers: [userId] }; // <-- per docs

  try {
    const { status, data } = await axios.post(url, body, { headers });
    console.log(`Follower add OK for contact ${contactId} user ${userId} -> ${status}`);
    return true;
  } catch (e) {
    const status = e?.response?.status;
    const payload = e?.response?.data || e.message;
    if (status === 409) {
      console.log(`User ${userId} already follows contact ${contactId}`);
      return true;
    }
    console.warn('Follower add failed:', status, payload);
    return false;
  }
}





// --- GET AVAILABLE SLOTS ENDPOINT ---
// --- PASTE THIS NEW FUNCTION IN ITS PLACE ---
app.get('/available-slots', async (req, res) => {
    const { location, language, experience, technician } = req.query; // Added technician
    const apiKey = process.env.GHL_API_KEY;

    if (!location || !language || !experience) {
        return res.status(400).json({ message: "Missing required query parameters." });
    }

    let artistCalendarIds = [];
    let translatorCalendarIds = [];

    if (technician && artistConfig[technician.toLowerCase()]) {
        // If a specific technician is requested, use only their calendars
        const artist = artistConfig[technician.toLowerCase()];
        artistCalendarIds = location === 'In-Person' ? [artist.inPerson] : [artist.online];
        console.log(`Filtering availability for specific technician: ${technician}`);
    } else {
        // Otherwise, use the all-artists logic
        if (location === 'In-Person') {
            artistCalendarIds = Object.values(artistConfig).map(artist => artist.inPerson);
        } else if (location === 'Online') {
            artistCalendarIds = Object.values(artistConfig).map(artist => artist.online);
        }
    }

    if (location === 'In-Person') {
        translatorCalendarIds = Object.values(translatorConfig).map(t => t.inPerson);
    } else if (location === 'Online') {
        translatorCalendarIds = Object.values(translatorConfig).map(t => t.online);
    }

    const isTranslatorRequired = (language === 'English' && experience === 'VIP');

    try {
        const artistPromises = artistCalendarIds.map(id => getSlotsForCalendar(apiKey, id));
        const artistResults = await Promise.all(artistPromises);
        const uniqueArtistSlots = new Set(artistResults.flat());

        if (!isTranslatorRequired) {
            return res.json({ availableSlots: Array.from(uniqueArtistSlots).sort() });
        }

        const translatorPromises = translatorCalendarIds.map(id => getSlotsForCalendar(apiKey, id));
        const translatorResults = await Promise.all(translatorPromises);
        const uniqueTranslatorSlots = new Set(translatorResults.flat());

        const finalSlots = new Set();
        for (const slot of uniqueArtistSlots) {
            if (uniqueTranslatorSlots.has(slot)) {
                finalSlots.add(slot);
            }
        }
        res.json({ availableSlots: Array.from(finalSlots).sort() });
    } catch (error) {
        console.error("Error in /available-slots:", error);
        res.status(500).json({ message: "An internal server error occurred." });
    }
});


// --- CREATE BOOKING ENDPOINT ---
// --- PASTE THIS FINAL FUNCTION IN ITS PLACE ---
app.post('/create-booking', async (req, res) => {
  //
  // helper so we can exit from anywhere with a clean JSON response
  // and (optionally) auto-refund before exiting
  //
  async function failOut(status, payload, opts = {}) {
    const { refundPaymentId, refundAmount } = opts;
    if (refundPaymentId && refundAmount) {
      await refundIfNeeded(refundPaymentId, refundAmount);
    }
    return res.status(status).json(payload);
  }

  try {
    // ----- unpack incoming body -----
    const {
      formDetails,
      selectedSlot,
      answers,
      utmParameters,
      language,
      experience,
      location,
      technician
    } = req.body;

    const apiKey = process.env.GHL_API_KEY;
        // 🔹 NEW: normalize experience for display + CRM
    const experienceLabel = normalizeExperience(experience); // "Signature" or "Reserve"

    // ----- figure out deposit amount (single source of truth) -----
    const depositUSD  = computeDepositUSD(answers, experience); // 50 or 100
    const depositAmount = depositUSD * 100;                     // cents
    let paymentId = null;                                       // set after Square charge


    //
    // STEP 1: visibility / calendar sanity
    //
    let visible;
    try {
      visible = await listCalendarsForLocation(apiKey, GHL_LOCATION_ID);
      const visibleIdsLog = visible.idSet ? Array.from(visible.idSet).join(', ') : '(none)';
      console.log('Calendars visible to this token/location:', visibleIdsLog);
    } catch (e) {
      console.error('Failed to list calendars for LocationId', GHL_LOCATION_ID,
                    e?.response?.data || e.message);
      return failOut(500, {
        code: 'CONFIG_ERROR',
        message: 'Calendar visibility failed for this Location. Check API key vs LocationId.'
      });
    }

    //
    // STEP 2: CHARGE CARD (Square)
    //
    try {
      const tokenFromBrowser = String(formDetails.paymentToken || '');
      console.log('Token received from browser:', tokenFromBrowser ? tokenFromBrowser.slice(0,8)+'...' : '(missing)');
      console.log(`Attempting to create payment of ${depositAmount} cents at location ${SQUARE_LOCATION_ID}...`);

      const pay = await createSquarePayment({
        sourceId: formDetails.paymentToken,
        amount: depositAmount,
        locationId: SQUARE_LOCATION_ID,
        note: 'Tattoo deposit'
      });

      paymentId = pay?.payment?.id;
      console.log('Square payment successful:', paymentId);
    } catch (error) {
      const full = error?.response?.data || error?.body || error;
      console.error('Square payment failed (full):', JSON.stringify(full, null, 2));
      const detail = full?.errors?.[0]?.detail || full?.message;
      return failOut(400, {
        code: 'PAYMENT_FAILED',
        message: detail || 'Payment failed. Please check your card details and try again.'
      });
    }

    //
    // STEP 3: ASSIGN ARTIST + TRANSLATOR
    //
    // Is translator needed?
    const isTranslatorRequired = (language === 'English' && experience === 'VIP');

    // Build calendarId lookup for artists depending on in-person vs online
    let allArtistIds = {};
    if (location === 'In-Person') {
      Object.keys(artistConfig).forEach(key => {
        allArtistIds[key.toUpperCase()] = artistConfig[key].inPerson;
      });
    } else {
      Object.keys(artistConfig).forEach(key => {
        allArtistIds[key.toUpperCase()] = artistConfig[key].online;
      });
    }

    // Build calendarId lookup for translators
    let allTranslatorIds = {};
    if (location === 'In-Person') {
      Object.keys(translatorConfig).forEach(key => {
        allTranslatorIds[key.toUpperCase()] = translatorConfig[key].inPerson;
      });
    } else {
      Object.keys(translatorConfig).forEach(key => {
        allTranslatorIds[key.toUpperCase()] = translatorConfig[key].online;
      });
    }

    // Filter calendars by what the token can actually "see" (if idSet exists)
    const filterVisible = (obj) =>
      !visible.idSet
        ? obj
        : Object.fromEntries(
            Object.entries(obj).filter(([, calId]) => visible.idSet.has(calId))
          );

    allArtistIds     = filterVisible(allArtistIds);
    allTranslatorIds = filterVisible(allTranslatorIds);

    // If we had a visibility list AND after filtering there are 0 artist calendars,
    // that's a config problem.
    if (visible.idSet && !Object.keys(allArtistIds).length) {
      console.error('No artist calendars in this LocationId. Check env ARTIST_* ids.');
      return failOut(500, {
        code: 'CONFIG_ERROR',
        message: 'No artist calendars are visible for this Location. Verify calendar IDs.'
      }, {
        refundPaymentId: paymentId,
        refundAmount: depositAmount
      });
    }

    // We'll look at workload per user to choose the fairest artist.
    const { startMillis, endMillis } = computeWindowMillis();
    let workloadByUser = null;
    try {
      const artistUserIds = Object.values(ARTIST_USER_IDS).filter(Boolean);
      workloadByUser = await getWorkloadCountsByUser(
        apiKey,
        GHL_LOCATION_ID,
        artistUserIds,
        startMillis,
        endMillis
      );
      console.log('Workload counts (window):', workloadByUser);
    } catch (err) {
      console.warn('Could not read per-user workload; using fallback scores. Reason:',
                   err?.response?.data || err.message);
      workloadByUser = null;
    }

    // We will fill these:
    let assignedArtistId = null;
    let assignedArtistUserId = null;
    let assignedTranslatorId = null;
    let assignedTranslatorUserId = null;

    //
    // 3A. Technician override logic
    // If technician=Claudia (from URL / payload), try to FORCE that artist
    //
    if (technician) {
      const techKey = technician.toLowerCase(); // "claudia"
      const forcedArtistCalId = (location === 'In-Person')
        ? artistConfig[techKey]?.inPerson
        : artistConfig[techKey]?.online;

      // map "claudia" -> ARTIST_USER_IDS.CLAUDIA
      const forcedArtistUserId = (() => {
        const upper = techKey.toUpperCase(); // "CLAUDIA"
        return ARTIST_USER_IDS[upper];
      })();

      if (!forcedArtistCalId) {
        console.error(`Technician override "${technician}" did not match a calendar for this location.`);
      } else {
        try {
          // confirm that exact slot is actually free for that artist
          const slotsForForcedArtist = await getSlotsForCalendar(apiKey, forcedArtistCalId);
          if (slotsForForcedArtist.includes(selectedSlot)) {
            assignedArtistId = forcedArtistCalId;
            assignedArtistUserId = forcedArtistUserId || null;
            console.log(
              `Forced technician "${technician}" assigned. ` +
              `calendarId=${assignedArtistId}, userId=${assignedArtistUserId || '(none)'}`
            );
          } else {
            console.warn(
              `Forced technician "${technician}" is not free at ${selectedSlot}. ` +
              `Will fall back to workload pick.`
            );
          }
        } catch (err) {
          console.warn(
            `Failed to confirm slots for forced tech "${technician}":`,
            err?.response?.data || err.message
          );
        }
      }
    }

    //
    // 3B. Fallback auto-pick if we still don't have an artist
    //
    if (!assignedArtistId) {
      // Check each available artist calendar to see who has this slot
      const artistAvailabilityPromises = Object.values(allArtistIds).map(id =>
        getSlotsForCalendar(apiKey, id)
      );
      const artistAvailabilities = await Promise.all(artistAvailabilityPromises);

      let availableArtists = [];
      Object.keys(allArtistIds).forEach((key, index) => {
        const hasSlot = artistAvailabilities[index]?.includes(selectedSlot);
        if (hasSlot) {
          const userId = ARTIST_USER_IDS[key]; // e.g. CLAUDIA -> that user's ID
          const workloadScore =
            (workloadByUser && workloadByUser[userId] != null)
              ? workloadByUser[userId]
              : 999; // if we couldn't read workload, treat as "busy"
          availableArtists.push({
            id: allArtistIds[key],
            name: key,
            userId,
            workload: workloadScore,
          });
        }
      });

      if (!availableArtists.length) {
        console.error("Slot taken, no artist available.");
        return failOut(409, {
          code: 'SLOT_TAKEN',
          message: "Sorry, that slot was just taken. Your deposit has been refunded."
        }, {
          refundPaymentId: paymentId,
          refundAmount: depositAmount
        });
      }

      // pick lowest workload
      availableArtists.sort((a, b) => a.workload - b.workload);
      assignedArtistId     = availableArtists[0].id;
      assignedArtistUserId = availableArtists[0].userId;
      console.log(
        `Assigned artist (auto): ${availableArtists[0].name} ` +
        `| workload=${availableArtists[0].workload} ` +
        `| calendarId=${assignedArtistId}`
      );
    }

    //
    // 3C. Translator (if required)
    //
    if (isTranslatorRequired) {
      const translatorAvailabilityPromises = Object.values(allTranslatorIds).map(id =>
        getSlotsForCalendar(apiKey, id)
      );
      const translatorAvailabilities = await Promise.all(translatorAvailabilityPromises);

      let availableTranslators = [];
      Object.keys(allTranslatorIds).forEach((key, index) => {
        if (translatorAvailabilities[index]?.includes(selectedSlot)) {
          availableTranslators.push({
            id:     allTranslatorIds[key],
            name:   key,
            userId: TRANSLATOR_USER_IDS[key], // ex. LIONEL, MARIA
          });
        }
      });

      if (!availableTranslators.length) {
        console.error("Slot taken, no translator available.");
        return failOut(409, {
          code: 'SLOT_TAKEN',
          message: "Sorry, that slot was just taken. Your deposit has been refunded."
        }, {
          refundPaymentId: paymentId,
          refundAmount: depositAmount
        });
      }

      assignedTranslatorId     = availableTranslators[0].id;
      assignedTranslatorUserId = availableTranslators[0].userId;
      console.log(
        `Assigned translator: ${availableTranslators[0].name} ` +
        `| calendarId=${assignedTranslatorId} ` +
        `| userId=${assignedTranslatorUserId || '(missing)'}`
      );
    }

    //
    // SAFETY CHECK: we MUST have an artist calendar before we continue
    //
    if (!assignedArtistId) {
      console.error('No assignedArtistId after fallback. Aborting.');
      return failOut(409, {
        code: 'SLOT_TAKEN',
        message: "Sorry, that slot was just taken. Your deposit has been refunded."
      }, {
        refundPaymentId: paymentId,
        refundAmount: depositAmount
      });
    }

    //
    // STEP 4: Prepare times + Google Meet (for online consults)
    //
    const startISO = selectedSlot;
    const DEFAULT_APPT_MINUTES = Number(process.env.DEFAULT_APPT_MINUTES || 40);
    const endISO = new Date(
      new Date(startISO).getTime() + DEFAULT_APPT_MINUTES * 60000
    ).toISOString();

    const isOnline = (location === 'Online');

    const appointmentTitle = buildApptTitle({
        lang: language,
        location,
        firstName: formDetails.firstName,
        lastName:  formDetails.lastName,
        experienceLabel // <-- "Signature" or "Reserve"
      });


    const attendeeEmails = isOnline ? [formDetails.email].filter(Boolean) : [];
    let meetUrl = null;

    if (isOnline) {
      try {
        const meetResp = await createGoogleMeet({
          summary:     appointmentTitle,
          description: `Studio AZ consultation for ${formDetails.firstName} ${formDetails.lastName}.`,
          startISO,
          endISO,
          attendees: attendeeEmails,
        });
        meetUrl = meetResp.meetUrl;
        console.log('Meet created:', meetUrl, '| calendar event:', meetResp.htmlLink);
      } catch (e) {
        console.warn('Meet creation failed (continuing without link):', e?.response?.data || e.message);
      }
    }

    //
    // STEP 5: Create / update contact in GHL
    // Includes: language tags, timeline custom field, UTM fields, meet link, etc.
    //
    let contactId;
    try {
      // Figure out which timeline Q they saw + what they picked
      const langAnswer = answers.q_language; // "English", "Spanish", "English/Spanish"

      const isSpanishOnly = (langAnswer === 'Spanish');

      // pull the user's choice from whichever timeline question they answered
      const timelineValue =
        answers['q_timeline_en'] ||
        answers['q_timeline_es'] ||
        '';

      // choose the correct GHL custom field key
      const timelineFieldKey = isSpanishOnly
        ? 'qu_tan_pronto_quiere_el_cliente'   // Spanish field API key
        : 'how_soon_is_client_deciding';      // English/bilingual field API key

      // build language tags
      const tagsToAdd = ['tattoolead'];
      if (langAnswer === 'English') {
        tagsToAdd.push('english');
      } else if (langAnswer === 'Spanish') {
        tagsToAdd.push('spanish');
      } else if (langAnswer === 'English/Spanish') {
        tagsToAdd.push('bilingual');
      }

      // helper to coerce and skip empties
      const cf = (key, value) => {
        const v = (value ?? "").toString().trim();
        return v ? { key, field_value: v } : null;
      };

      // build customFields array (clean + consistent)
      const customFields = [
        timelineValue && { key: timelineFieldKey, field_value: String(timelineValue).trim() },

        { key: "experience",                 field_value: String(experienceLabel).trim() },
        formDetails?.tattooSize        && { key: "size_of_tattoo",             field_value: String(formDetails.tattooSize).trim() },
        formDetails?.tattooPlacement   && { key: "location_of_tattoo_inquiry", field_value: String(formDetails.tattooPlacement).trim() },
        formDetails?.notesToArtist     && { key: "notes_to_artists_optional",  field_value: String(formDetails.notesToArtist).trim() },

        utmParameters?.source   && { key: "utm_source",   field_value: String(utmParameters.source).trim() },
        utmParameters?.medium   && { key: "utm_medium",   field_value: String(utmParameters.medium).trim() },
        utmParameters?.campaign && { key: "utm_campaign", field_value: String(utmParameters.campaign).trim() },

        { key: "last_deposit_amount_usd", field_value: (depositAmount / 100).toFixed(2) },
        { key: "last_deposit_at_iso",     field_value: new Date().toISOString() },
        { key: "square_payment_id",       field_value: paymentId || "" },
      ].filter(Boolean);


        if (meetUrl) {
        customFields.push({
            key: "google_meet_link",
            field_value: meetUrl
        });
        }

        // DEBUG LOGGING
        console.log('[CONTACT UPSERT] langAnswer:', langAnswer);
        console.log('[CONTACT UPSERT] timelineFieldKey:', timelineFieldKey);
        console.log('[CONTACT UPSERT] timelineValue:', timelineValue);
        console.log('[CONTACT UPSERT] experienceLabel:', experienceLabel); // 🔹 NEW
        console.log('[CONTACT UPSERT] customFields:', customFields);


      const contactPayload = {
        locationId: GHL_LOCATION_ID,
        firstName:  formDetails.firstName,
        lastName:   formDetails.lastName,
        email:      formDetails.email,
        phone:      formDetails.phone,
        source:     "Booking Widget",
        tags:       tagsToAdd,
        customFields
      };

      const ghlContactUrl = 'https://services.leadconnectorhq.com/contacts/upsert';

      const contactResponse = await axios.post(
        ghlContactUrl,
        contactPayload,
        { headers: { ...ghlHeaders(apiKey), Accept: 'application/json' } }
      );

      contactId = contactResponse.data.contact.id;
      console.log("GHL Contact created/updated with ID:", contactId);
    } catch (error) {
      console.error("Failed to create GHL contact:",
        error?.response?.data || error.message);
      return failOut(500, {
        code: 'CONTACT_FAILED',
        message: "Could not create contact. Your deposit has been refunded."
      }, {
        refundPaymentId: paymentId,
        refundAmount: depositAmount
      });
    }

    //
    // STEP 5.1: assign owner/follower (non-blocking)
    //
    try {
      if (assignedArtistUserId) {
        const okOwner = await assignContactOwner(apiKey, contactId, assignedArtistUserId, GHL_LOCATION_ID);
        if (!okOwner) console.warn('Could not assign artist as contact owner (non-blocking).');
      } else {
        console.warn('No assignedArtistUserId available to assign contact owner.');
      }

      if (isTranslatorRequired && assignedTranslatorUserId) {
        const okFollow = await addContactFollower(apiKey, contactId, assignedTranslatorUserId);
        if (!okFollow) console.warn('Could not add translator as contact follower (non-blocking).');
      }
    } catch (errFollow) {
      console.warn('Owner/follower step threw unexpectedly:', errFollow);
    }

    //
    // STEP 6: Book appointment(s) in GHL
    //
    try {
      const headers = ghlHeaders(apiKey);

      // helper so we reuse logic + also retry with endTime if GHL cluster requires it
      const createAppt = async (calendarId, assignedUserId) => {
        const payload = {
          calendarId,
          contactId,
          startTime: startISO,
          title: appointmentTitle,
          locationId: GHL_LOCATION_ID,
        };

        if (assignedUserId) {
          payload.assignedUserId = assignedUserId;
        }

        if (meetUrl) {
          payload.meetingLocationType = 'custom';
          payload.meetingLocationId   = 'custom_0';
          payload.address             = meetUrl;
          payload.notes               = `Google Meet: ${meetUrl}\n\nPlease join a few minutes early.`;
        }

        try {
          return await axios.post(
            'https://services.leadconnectorhq.com/calendars/events/appointments',
            payload,
            { headers }
          );
        } catch (e) {
          const status = e?.response?.status;
          const data   = e?.response?.data;
          const requiresEndTime =
            status === 400 &&
            data &&
            (String(data.message || '').toLowerCase().includes('endtime') ||
             String(data.error   || '').toLowerCase().includes('endtime'));

          if (!requiresEndTime) {
            throw e;
          }

          console.warn('Retrying appointment creation with endTime since API requires it.');
          return axios.post(
            'https://services.leadconnectorhq.com/calendars/events/appointments',
            { ...payload, endTime: endISO },
            { headers }
          );
        }
      };

      const promises = [
        createAppt(assignedArtistId, assignedArtistUserId)
      ];

      if (isTranslatorRequired && assignedTranslatorId) {
        promises.push(
          createAppt(assignedTranslatorId /* translators may not need assignedUserId */)
        );
      }

      await Promise.all(promises);
      console.log("GHL Appointments booked successfully.");
    } catch (error) {
      console.error("Failed to book GHL appointments:",
        error?.response?.data || error.message);

      return failOut(500, {
        code: 'BOOKING_FAILED',
        message: "Could not book the appointment. Your deposit has been refunded."
      }, {
        refundPaymentId: paymentId,
        refundAmount: depositAmount
      });
    }

    // STEP 6.1 (reuse existing values; do not redeclare)
    const oppName = `Consultation – ${experience === 'VIP' ? 'Reserve' : 'Signature'} – ${formDetails?.firstName || ''} ${formDetails?.lastName || ''}`.trim();

    try {
      await upsertOpportunityForContact({
        contactId,
        pipelineId: process.env.GHL_PIPELINE_ID,
        stageId: process.env.GHL_STAGE_ID, // “Deposit Paid (Consultation Booked)”
        monetaryValue: depositUSD,
        name: oppName,
        // assignedUserId: optional
      });
      console.log(`[GHL] Opportunity set to stage "Deposit Paid (Consultation Booked)" with value $${depositUSD}`);
    } catch (e) {
      console.error('[Booking] GHL opportunity update error:', e?.response?.data || e.message);
    }

    //
    // STEP 7: Success 🎉
    //
    return res.status(200).json({ message: "Booking successful!" });

  } catch (fatal) {
    // <-- GLOBAL CATCH:
    // If literally anything slipped past our internal try/catch,
    // we do NOT send HTML. We still send JSON.
    console.error('[FATAL /create-booking]', fatal);
    return res.status(500).json({
      code: 'UNEXPECTED',
      message: 'Internal booking error.'
    });
  }
});


// === SYNC ARTIST <-> TRANSLATOR VIA GHL WEBHOOK (payload-shape aware) ===
app.post('/webhooks/ghl', async (req, res) => {
  const sig = req.get('x-ghl-webhook-secret') || req.get('X-GHL-Webhook-Secret') || '';
  if (process.env.GHL_WEBHOOK_SECRET && sig !== process.env.GHL_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'invalid secret' });
  }

  // Ack immediately so GHL doesn’t retry
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      const body = req.body || {};
      const c = body.calendar || {};

      // IDs from your payload sample
      const contactId       = body.contact_id || body.contactId || body.contact?.id || null;
      const appointmentId   = c.appointmentId || null;              // DO NOT fall back to c.id (that’s the calendarId)
      const actorCalendarId = c.id || c.calendarId || null;         // calendar id (e.g. "6RVbtnl...")

      if (!contactId || !appointmentId || !actorCalendarId) {
        console.warn('[WB] missing essentials', { contactId, appointmentId, actorCalendarId });
        return;
      }

      // Status: prefer the misspelled field when present (your payload shows it)
      const rawStatus   = String(c.appoinmentStatus || c.status || '').toLowerCase();
      const isCancelled = ['cancelled', 'canceled'].includes(rawStatus);

      // Times are local-like (no trailing Z in payload)
      const startISO = c.startTime || null;
      const endISO   = c.endTime   || null;

      // Build calendar sets from env
      const translatorCalSet = new Set([
        process.env.TRANSLATOR_1_IN_PERSON_ID, process.env.TRANSLATOR_1_ONLINE_ID,
        process.env.TRANSLATOR_2_IN_PERSON_ID, process.env.TRANSLATOR_2_ONLINE_ID,
      ].filter(Boolean));

      const artistCalSet = new Set([
        process.env.ARTIST_1_IN_PERSON_ID, process.env.ARTIST_1_ONLINE_ID,
        process.env.ARTIST_2_IN_PERSON_ID, process.env.ARTIST_2_ONLINE_ID,
        process.env.ARTIST_3_IN_PERSON_ID, process.env.ARTIST_3_ONLINE_ID,
      ].filter(Boolean));

      const actorIsTranslator = translatorCalSet.has(actorCalendarId);
      const siblingCalIds = actorIsTranslator ? Array.from(artistCalSet) : Array.from(translatorCalSet);

      const headers = ghlHeaders(process.env.GHL_API_KEY);

      // Query a ±12h window around the reported time
      const approxStartMs = startISO ? Date.parse(startISO) : Date.now();
      const approxEndMs   = endISO   ? Date.parse(endISO)   : (approxStartMs + 40 * 60 * 1000);
      const pad           = 12 * 60 * 60 * 1000;
      const startMillis   = approxStartMs - pad;
      const endMillis     = approxEndMs + pad;

      // Cluster-safe: always include calendarId
      async function fetchEventsForCalendar(calId) {
        const url = `https://services.leadconnectorhq.com/calendars/events` +
          `?locationId=${GHL_LOCATION_ID}` +
          `&calendarId=${encodeURIComponent(calId)}` +
          `&startTime=${startMillis}` +
          `&endTime=${endMillis}`;
        const { data } = await axios.get(url, { headers });
        return data?.events || [];
      }

      const calendarsToQuery = [actorCalendarId, ...siblingCalIds];
      const results   = await Promise.allSettled(calendarsToQuery.map(fetchEventsForCalendar));
      const allEvents = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

      const mine = allEvents.find(ev => ev.id === appointmentId)
              || allEvents.find(ev => ev.calendarId === actorCalendarId && ev.contactId === contactId);

      const siblings = allEvents.filter(ev =>
        ev.contactId === contactId &&
        ev.id !== appointmentId &&
        siblingCalIds.includes(ev.calendarId)
      );

      if (!siblings.length) {
        console.log('[WB] no sibling found', { contactId, appointmentId, actorCalendarId });
        return;
      }

      // === CANCEL flow ===
      if (isCancelled) {
      // We only touch siblings that *aren't* already cancelled
      const targets = siblings.filter(s => {
        const st = String(s.appointmentStatus || s.status || '').toLowerCase();
        return !['cancelled', 'canceled'].includes(st);
      });

      await Promise.all(targets.map(async (ev) => {
        const soft = await cancelSoft(ev, headers);

        if (soft.ok) {
        console.log('[WB] marked sibling as cancelled via', soft.method, ev.id);
        return;
        }

        // IMPORTANT CHANGE:
        // We NO LONGER DELETE the sibling appointment if we can't cancel it.
        // We just log the problem.
        console.warn(
        '[WB] could NOT mark sibling as cancelled (leaving it in place):',
        ev.id,
        soft.errors
        );
      }));

      return;
      }


      // === RESCHEDULE flow ===
      const newStart = (mine?.startTime || startISO);
        const newEnd   = (mine?.endTime   || endISO);

        if (!newStart || !newEnd) {
        console.log('[WB] no times to mirror');
        return;
        }

        await Promise.all(siblings.map(async (ev) => {
        // avoid pointless updates / infinite bouncing
        const alreadySame =
            (ev.startTime && ev.startTime === newStart) &&
            (ev.endTime   && ev.endTime   === newEnd);
        if (alreadySame) return;

        const soft = await rescheduleSibling(ev, headers, newStart, newEnd);

        if (soft.ok) {
            console.log('[WB] rescheduled sibling via', soft.method, ev.id, '->', { newStart, newEnd });
            return;
        }

        console.warn(
            '[WB] could NOT reschedule sibling (leaving it with old time):',
            ev.id,
            soft.errors
        );
      }));
    } catch (err) {
      console.error('[WB] Handler error:', err?.response?.data || err);
    }
  });
}); // <-- closes app.post('/webhooks/ghl', ...)

// leave this route after the ghl webhook:
app.post('/webhooks/echo', (req, res) => {
  const sig = req.get('x-ghl-webhook-secret') || req.get('X-GHL-Webhook-Secret') || '';
  if (process.env.GHL_WEBHOOK_SECRET && sig !== process.env.GHL_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'invalid secret' });
  }
  console.log('[ECHO] headers:', req.headers);
  console.log('[ECHO] body len:', Buffer.byteLength(JSON.stringify(req.body || {})));
  res.json({ ok: true, got: { path: req.path, bodyKeys: Object.keys(req.body || {}) } });
});

app.listen(PORT, () => console.log(`Server on :${PORT}`));