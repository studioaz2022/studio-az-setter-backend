#!/usr/bin/env node
// One-off backfill: set the CRM owner (assignedTo) on tattoo contacts that
// have an assigned artist (inquired_technician) but no owner, caused by the
// updateContactAssignedUser bug that sent { assignedUserId } (422'd) instead
// of { assignedTo }. Fixed in commit c691636 — this repairs existing leads.
//
// Scope: contacts attached to OPEN opportunities in the Tattoo pipeline.
// Source of truth for the owner: the contact's inquired_technician value,
// with the opportunity's follower (an artist user id) as a fallback.
//
// Usage:
//   node scripts/backfill-contact-owners.js            # DRY RUN (default)
//   DRY_RUN=false node scripts/backfill-contact-owners.js   # execute writes
require("dotenv").config({ quiet: true });

const { searchOpportunities } = require("../src/clients/ghlOpportunityClient");
const { getContact, updateContactAssignedUser } = require("../src/clients/ghlClient");
const { getAssignedUserIdForArtist } = require("../src/ai/artistRouter");

const PIPELINE_ID = "Q4QmvAi6bzvdk1rWRkgV";        // Tattoo pipeline
const INQUIRED_TECH_FIELD_ID = "H3PSN8tZSw1kYckHJN9D"; // inquired_technician custom field
const DRY_RUN = process.env.DRY_RUN !== "false";       // default: dry run

// Known artist user ids — a follower is only usable as an owner fallback if it
// is actually one of the artists (opportunities can have non-artist followers).
const ARTIST_USER_IDS = {
  "1wuLf50VMODExBSJ9xPI": "Joan",
  "O8ChoMYj1BmMWJJsDlvC": "Andrew",
  "BaSmQL1fkhdjmCYuDRWK": "Megan",
  "C94R2IHBHHf0yuPzBpuS": "Kaelani",
};

async function main() {
  console.log(`\n🔧 Backfill contact owners — DRY_RUN=${DRY_RUN}\n`);

  const opps = await searchOpportunities({
    query: { status: "open", pipelineId: PIPELINE_ID },
  });

  // Unique contactIds + first artist-follower per contact (fallback owner).
  const contactIds = [...new Set(opps.map((o) => o.contactId).filter(Boolean))];
  const followerByContact = {};
  for (const o of opps) {
    if (!o.contactId || followerByContact[o.contactId]) continue;
    const artistFollower = (o.followers || []).find((f) => ARTIST_USER_IDS[f]);
    if (artistFollower) followerByContact[o.contactId] = artistFollower;
  }

  console.log(
    `Open opps: ${opps.length} | unique contacts: ${contactIds.length}\n`
  );

  let alreadyOwned = 0, toSet = 0, set = 0, noArtist = 0, failed = 0;
  const rows = [];

  for (const cid of contactIds) {
    const contact = await getContact(cid);
    if (!contact) { failed++; rows.push(["ERR-FETCH", "", "", "", cid]); continue; }

    if (contact.assignedTo) { alreadyOwned++; continue; }

    const name = `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || "(no name)";
    const inquired = contact.customField?.[INQUIRED_TECH_FIELD_ID] || "";

    // Resolve owner: inquired_technician first, then artist-follower fallback.
    let userId = inquired ? getAssignedUserIdForArtist(inquired) : null;
    let source = "inquired_technician";
    if (!userId && followerByContact[cid]) {
      userId = followerByContact[cid];
      source = "opp_follower";
    }

    if (!userId) {
      noArtist++;
      rows.push(["SKIP-noartist", name, inquired || "(none)", "-", cid]);
      continue;
    }

    const artistName = ARTIST_USER_IDS[userId] || inquired;
    if (DRY_RUN) {
      toSet++;
      rows.push(["WOULD-SET", name, artistName, `${userId} (${source})`, cid]);
    } else {
      const res = await updateContactAssignedUser(cid, userId);
      if (res) { set++; rows.push(["SET", name, artistName, `${userId} (${source})`, cid]); }
      else { failed++; rows.push(["FAIL-write", name, artistName, `${userId} (${source})`, cid]); }
    }
  }

  console.log("Result       | Name                   | Artist   | Owner id (source)");
  console.log("-------------|------------------------|----------|-------------------");
  for (const [r, name, artist, owner, cid] of rows) {
    console.log(`${r.padEnd(12)} | ${String(name).padEnd(22)} | ${String(artist).padEnd(8)} | ${owner}  ${cid}`);
  }

  console.log(
    `\nSummary: already-owned=${alreadyOwned} | ${DRY_RUN ? "would-set" : "set"}=${DRY_RUN ? toSet : set} | no-artist=${noArtist} | failed=${failed} | total=${contactIds.length}`
  );
  if (DRY_RUN) console.log("\n(DRY RUN — no writes made. Re-run with DRY_RUN=false to apply.)");
}

main().catch((e) => { console.error("❌ Backfill error:", e); process.exit(1); });
