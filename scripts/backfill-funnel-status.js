#!/usr/bin/env node
// backfill-funnel-status.js — one-time: protect existing leads from the v2 bot at launch.
//
// Every contact that predates v2 has no funnel_status. When v2 goes live, their next message
// would hit the classifier cold (and a context-free reply could be mis-handled). To guarantee
// the bot NEVER interferes with conversations a human has been running, we set every existing
// contact-with-a-conversation to funnel_status = paused_manual. The v2 pipeline checks
// paused_manual FIRST and stays silent until a human explicitly resumes — so backfilled leads
// stay 100% human-handled. Only genuinely NEW post-launch leads (no funnel_status) reach the bot.
//
// Idempotent: skips contacts that already have ANY funnel_status (won't clobber).
// Safe by default: DRY-RUN unless --apply is passed.
//
// Usage:
//   node scripts/backfill-funnel-status.js            # dry-run: show scope, write nothing
//   node scripts/backfill-funnel-status.js --apply     # live: set paused_manual
//   node scripts/backfill-funnel-status.js --days 90   # only convos active in last 90 days
//
// stderr is muted (the GHL SDK logs the auth token to stderr on 4xx).

require("dotenv").config({ quiet: true });
const { ghl } = require("../src/clients/ghlSdk");
const { getContact, updateContact } = require("../src/clients/ghlClient");
const { buildEffectiveContact } = require("../src/ai/contextBuilder");
const { SYSTEM_FIELDS, FUNNEL_STATUSES } = require("../src/config/constants");

const LOC = process.env.GHL_LOCATION_ID;
const APPLY = process.argv.includes("--apply");
const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg !== -1 ? parseInt(process.argv[daysArg + 1], 10) : null;
const cutoff = DAYS ? Date.now() - DAYS * 86400000 : 0;

async function collectContacts() {
  const seen = new Map(); // contactId -> { name, lastMessageDate }
  let startAfterDate = undefined;
  let page = 0;
  while (true) {
    const d = await ghl.conversations.searchConversation({
      locationId: LOC, sortBy: "last_message_date", sort: "desc", limit: 100,
      ...(startAfterDate ? { startAfterDate } : {}),
    });
    const convs = d?.conversations || [];
    if (!convs.length) break;
    let hitCutoff = false;
    for (const c of convs) {
      const last = c.lastMessageDate || (c.sort && c.sort[0]) || 0;
      if (cutoff && last < cutoff) { hitCutoff = true; break; }
      if (c.contactId && !seen.has(c.contactId)) seen.set(c.contactId, { name: c.fullName || c.contactName || "?", last });
    }
    page++;
    const lastConv = convs[convs.length - 1];
    startAfterDate = lastConv.lastMessageDate || (lastConv.sort && lastConv.sort[0]);
    if (hitCutoff || convs.length < 100) break;
    if (page > 100) break; // safety
  }
  return seen;
}

(async () => {
  console.log(`\n🛡️  Backfill funnel_status=paused_manual  | mode=${APPLY ? "APPLY (live)" : "DRY-RUN"}${DAYS ? ` | window=${DAYS}d` : " | window=all"}\n`);
  const contacts = await collectContacts();
  const ids = [...contacts.keys()];
  console.log(`Found ${ids.length} unique contacts with conversations${DAYS ? ` in the last ${DAYS}d` : ""}.`);
  if (ids.length) {
    const dates = [...contacts.values()].map((v) => v.last).filter(Boolean).sort();
    console.log(`  active range: ${new Date(dates[0]).toISOString().slice(0,10)} → ${new Date(dates[dates.length-1]).toISOString().slice(0,10)}`);
    console.log("  sample:");
    [...contacts.entries()].slice(0, 8).forEach(([id, v]) => console.log(`    ${id}  ${v.name}`));
  }

  if (!APPLY) {
    console.log(`\n(DRY-RUN — nothing written. Re-run with --apply to set paused_manual.)\n`);
    return;
  }

  let set = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    try {
      const raw = await getContact(id);
      const contact = buildEffectiveContact(raw, {});
      const existing = contact.customField?.[SYSTEM_FIELDS.FUNNEL_STATUS];
      if (existing) { skipped++; continue; } // already has a status — don't clobber
      await updateContact(id, { customField: { [SYSTEM_FIELDS.FUNNEL_STATUS]: FUNNEL_STATUSES.PAUSED_MANUAL } });
      set++;
      if (set % 25 === 0) console.log(`  …${set} set`);
    } catch (e) {
      failed++;
    }
  }
  console.log(`\n✅ Backfill done — set=${set} skipped(already had status)=${skipped} failed=${failed} of ${ids.length}\n`);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
