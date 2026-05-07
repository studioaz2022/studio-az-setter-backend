/**
 * Reconciliation Venmo Handler (Phase 5)
 *
 * Given a parsed Venmo email that's been flagged as a reconciliation candidate
 * (note contains [a:XXXNNNN] or "StudioAZ Recon"), perform the strict
 * settlement workflow:
 *
 *   1. Extract the [a:XXXNNNN] code from the note.
 *   2. Look up reconciliations.venmo_code = code.
 *   3. Verify amount matches net_amount within 1¢.
 *   4. Verify direction is consistent with parties on the email.
 *   5. If all pass → mark settled, return { decision: "settled", reconciliationId }.
 *      Else → return { decision: "deferred_*", reason } so caller can notify.
 *
 * Always inserts an audit row into reconciliation_email_log.
 *
 * No row creation here — Phase 5's eager-create lives on the /current endpoint
 * (so that by the time Lionel sends a Venmo, the row already exists). If the
 * row truly doesn't exist (e.g. Lionel sent an early Venmo before the artist
 * opened the Finance tab), this handler creates the row from completions then
 * settles.
 *
 * See TATTOO_FINANCE_PLAN.md Phase 5.
 */

const { supabase } = require("../clients/supabaseClient");
const {
  parseReconciliationCode,
  decodeReconciliationCode,
  parseOutgoingVenmoEmail,
  verifyDirection,
  amountsMatch,
} = require("./reconciliationVenmoParser");
const {
  computeWeeklyReconciliation,
} = require("./reconciliationService");
const { getWeekStart, getWeekEnd, formatWeekRange } = require("../utils/dateUtils");
const {
  sendReconciliationSettledNotification,
  sendReconciliationConfirmNotification,
} = require("./reconciliationNotifications");

const OWNER_VENMO_DISPLAY_NAME = "Leonel Chavez"; // matches venmo_connections seed
const TATTOO_LOCATION_ID = process.env.GHL_LOCATION_ID || "mUemx2jG4wly4kJWBkI4";

/**
 * Insert an audit row. Failures here are logged but do not abort the webhook —
 * audit is best-effort.
 */
async function logEmail({
  rawPayload,
  parsedSender,
  parsedAmount,
  parsedNote,
  parsedCode,
  parsedDirection,
  artistGhlId,
  reconciliationId,
  decision,
  decisionNote,
}) {
  try {
    await supabase.from("reconciliation_email_log").insert({
      raw_payload: rawPayload || null,
      parsed_sender: parsedSender || null,
      parsed_amount: parsedAmount || null,
      parsed_note: parsedNote || null,
      parsed_code: parsedCode || null,
      parsed_direction: parsedDirection || null,
      artist_ghl_id: artistGhlId || null,
      reconciliation_id: reconciliationId || null,
      decision,
      decision_note: decisionNote || null,
    });
  } catch (err) {
    console.error("  ⚠️ [Recon] audit log insert failed:", err.message || err);
  }
}

/**
 * Look up the reconciliations row by venmo_code. If absent but completions
 * exist for that artist/week, eager-create it.
 *
 * Decoding the code yields { artistPrefix, monthDay } — but the prefix alone
 * isn't enough to disambiguate artists (CHA could be Claudia or Chavez), and
 * monthDay alone doesn't carry the year. So we strictly look up by exact code
 * match. Eager-create-on-not-found needs an artist+week, which we can't
 * recover from the code alone — those are created by the /current endpoint
 * (Phase 5, decision E).
 */
async function findReconciliationByCode(code) {
  const { data, error } = await supabase
    .from("reconciliations")
    .select("*")
    .eq("venmo_code", code)
    .maybeSingle();
  if (error) {
    console.error("  ⚠️ [Recon] lookup error:", error.message);
    return null;
  }
  return data || null;
}

/**
 * Mark a reconciliation row as settled. Idempotent — second call no-ops if
 * already settled (returns the already-settled row).
 */
async function markSettled({ reconciliationId, settlementPaymentId, method = "venmo_auto" }) {
  // Read current state first
  const { data: current, error: readErr } = await supabase
    .from("reconciliations")
    .select("id, status, settled_at, settled_via, settlement_payment_id")
    .eq("id", reconciliationId)
    .maybeSingle();
  if (readErr || !current) {
    return { ok: false, reason: readErr?.message || "not-found" };
  }

  if (current.status === "settled") {
    return { ok: true, alreadySettled: true, row: current };
  }

  const { data, error } = await supabase
    .from("reconciliations")
    .update({
      status: "settled",
      settled_at: new Date().toISOString(),
      settled_via: method,
      settlement_payment_id: settlementPaymentId || null,
    })
    .eq("id", reconciliationId)
    .eq("status", "pending") // race-safe: only settle from pending
    .select()
    .maybeSingle();

  if (error) {
    return { ok: false, reason: error.message };
  }
  if (!data) {
    // Lost the race — re-read
    const { data: refetch } = await supabase
      .from("reconciliations")
      .select("*")
      .eq("id", reconciliationId)
      .maybeSingle();
    return { ok: true, alreadySettled: true, row: refetch };
  }
  return { ok: true, alreadySettled: false, row: data };
}

/**
 * Look up artist info (display name) for direction-verification + push routing.
 */
async function fetchArtistInfo(artistGhlId) {
  const { data } = await supabase
    .from("artist_commission_rates")
    .select("artist_name, artist_ghl_id, location_id")
    .eq("artist_ghl_id", artistGhlId)
    .is("effective_to", null)
    .maybeSingle();
  return data || null;
}

/**
 * Main entry: handle a Venmo email already determined to be a reconciliation
 * candidate (caller already verified looksLikeReconciliation).
 *
 * @param {object} args
 * @param {object} args.parsed             — parseVenmoEmail() output (incoming)
 * @param {string} args.rawPlain
 * @param {string} args.rawHtml
 * @param {string} args.emailDate
 * @param {object} args.rawPayload         — full webhook body for audit
 * @returns {Promise<{ ok: boolean, decision: string, reconciliationId?: string, message?: string }>}
 */
async function handleReconciliationVenmoEmail({
  parsed,
  rawPlain,
  rawHtml,
  emailDate,
  rawPayload,
}) {
  const noteForCode = parsed.note || rawPlain || "";
  let code = parseReconciliationCode(noteForCode);
  let parserDirection = "incoming";
  let outgoingParsed = null;

  // Even if the note didn't have it, also try parsing as an OUTGOING email
  // (Lionel forwarded his own "You paid" confirmation). Important for direction B.
  outgoingParsed = parseOutgoingVenmoEmail(rawPlain || "", rawHtml || "", emailDate);
  if (outgoingParsed) {
    if (!code && outgoingParsed.note) {
      code = parseReconciliationCode(outgoingParsed.note);
    }
    if (code) parserDirection = "outgoing";
  }

  const amountForMatch = parserDirection === "outgoing"
    ? outgoingParsed.amount
    : parsed.amount;
  const senderForLog = parserDirection === "outgoing"
    ? `${outgoingParsed.ownerName} → ${outgoingParsed.recipientName}`
    : parsed.senderName;

  // No code found anywhere → defer
  if (!code) {
    console.log("  📋 [Recon] No [a:] code in note — defer (per Phase 5 fuzzy policy)");
    await logEmail({
      rawPayload,
      parsedSender: senderForLog,
      parsedAmount: amountForMatch,
      parsedNote: parsed.note || outgoingParsed?.note || null,
      parsedCode: null,
      parsedDirection: parserDirection,
      decision: "deferred_no_code",
      decisionNote: "StudioAZ Recon marker without [a:XXXNNNN] code — manual review needed",
    });
    return {
      ok: true,
      decision: "deferred_no_code",
      message: "No [a:XXXNNNN] code found in note",
    };
  }

  console.log(`  🔎 [Recon] Code: ${code} · parserDirection: ${parserDirection} · amount: $${amountForMatch}`);

  // Look up the reconciliation row by code
  const reconciliation = await findReconciliationByCode(code);
  if (!reconciliation) {
    console.log(`  ⚠️ [Recon] No reconciliation found for code ${code} — defer`);
    await logEmail({
      rawPayload,
      parsedSender: senderForLog,
      parsedAmount: amountForMatch,
      parsedNote: parsed.note || outgoingParsed?.note || null,
      parsedCode: code,
      parsedDirection: parserDirection,
      decision: "deferred_unknown_code",
      decisionNote: `code ${code} doesn't match any existing reconciliations row`,
    });
    return {
      ok: true,
      decision: "deferred_unknown_code",
      message: `Code ${code} not found`,
    };
  }

  console.log(`  ✓ [Recon] Found row id=${reconciliation.id} · artist=${reconciliation.artist_ghl_id} · net=$${reconciliation.net_amount} · direction=${reconciliation.direction} · status=${reconciliation.status}`);

  // Already settled — idempotent no-op
  if (reconciliation.status === "settled") {
    console.log("  ✓ [Recon] Already settled — idempotent no-op");
    await logEmail({
      rawPayload,
      parsedSender: senderForLog,
      parsedAmount: amountForMatch,
      parsedNote: parsed.note || outgoingParsed?.note || null,
      parsedCode: code,
      parsedDirection: parserDirection,
      artistGhlId: reconciliation.artist_ghl_id,
      reconciliationId: reconciliation.id,
      decision: "deferred_already_settled",
      decisionNote: "row already settled prior to this email",
    });
    return {
      ok: true,
      decision: "deferred_already_settled",
      reconciliationId: reconciliation.id,
    };
  }

  // Verify amount (1¢ tolerance)
  if (!amountsMatch(amountForMatch, Number(reconciliation.net_amount))) {
    const reason = `expected $${reconciliation.net_amount} but received $${amountForMatch}`;
    console.log(`  ⚠️ [Recon] Amount mismatch: ${reason}`);
    await logEmail({
      rawPayload,
      parsedSender: senderForLog,
      parsedAmount: amountForMatch,
      parsedNote: parsed.note || outgoingParsed?.note || null,
      parsedCode: code,
      parsedDirection: parserDirection,
      artistGhlId: reconciliation.artist_ghl_id,
      reconciliationId: reconciliation.id,
      decision: "deferred_amount_mismatch",
      decisionNote: reason,
    });
    // Push a "please confirm" notification — artist may want to investigate
    try {
      await sendReconciliationConfirmNotification({
        artistGhlUserId: reconciliation.artist_ghl_id,
        amount: amountForMatch,
        reason: "amount mismatch",
      });
    } catch (e) {
      console.error("  ⚠️ [Recon] confirm push failed:", e.message);
    }
    return { ok: true, decision: "deferred_amount_mismatch", message: reason };
  }

  // Verify direction
  const artistInfo = await fetchArtistInfo(reconciliation.artist_ghl_id);
  if (!artistInfo || !artistInfo.artist_name) {
    console.log(`  ⚠️ [Recon] Could not fetch artist info for ${reconciliation.artist_ghl_id} — defer`);
    await logEmail({
      rawPayload,
      parsedSender: senderForLog,
      parsedAmount: amountForMatch,
      parsedNote: parsed.note || outgoingParsed?.note || null,
      parsedCode: code,
      parsedDirection: parserDirection,
      artistGhlId: reconciliation.artist_ghl_id,
      reconciliationId: reconciliation.id,
      decision: "deferred_direction_mismatch",
      decisionNote: "missing artist info for direction verification",
    });
    return { ok: true, decision: "deferred_direction_mismatch" };
  }

  const dirCheck = verifyDirection({
    reconDirection: reconciliation.direction,
    artistName: artistInfo.artist_name,
    ownerVenmoName: OWNER_VENMO_DISPLAY_NAME,
    parsed: parserDirection === "outgoing" ? outgoingParsed : parsed,
    parserDirection,
  });

  if (!dirCheck.ok) {
    console.log(`  ⚠️ [Recon] Direction mismatch: ${dirCheck.reason}`);
    await logEmail({
      rawPayload,
      parsedSender: senderForLog,
      parsedAmount: amountForMatch,
      parsedNote: parsed.note || outgoingParsed?.note || null,
      parsedCode: code,
      parsedDirection: parserDirection,
      artistGhlId: reconciliation.artist_ghl_id,
      reconciliationId: reconciliation.id,
      decision: "deferred_direction_mismatch",
      decisionNote: dirCheck.reason,
    });
    try {
      await sendReconciliationConfirmNotification({
        artistGhlUserId: reconciliation.artist_ghl_id,
        amount: amountForMatch,
        reason: "direction mismatch",
      });
    } catch (e) {
      console.error("  ⚠️ [Recon] confirm push failed:", e.message);
    }
    return { ok: true, decision: "deferred_direction_mismatch", message: dirCheck.reason };
  }

  // All checks passed — settle!
  const txId = parserDirection === "outgoing"
    ? outgoingParsed.transactionId
    : parsed.transactionId;
  const settleResult = await markSettled({
    reconciliationId: reconciliation.id,
    settlementPaymentId: txId || null,
    method: "venmo_auto",
  });

  if (!settleResult.ok) {
    console.error(`  ❌ [Recon] settle failed: ${settleResult.reason}`);
    await logEmail({
      rawPayload,
      parsedSender: senderForLog,
      parsedAmount: amountForMatch,
      parsedNote: parsed.note || outgoingParsed?.note || null,
      parsedCode: code,
      parsedDirection: parserDirection,
      artistGhlId: reconciliation.artist_ghl_id,
      reconciliationId: reconciliation.id,
      decision: "error",
      decisionNote: `settle update failed: ${settleResult.reason}`,
    });
    return { ok: false, decision: "error", message: settleResult.reason };
  }

  console.log(`  ✅ [Recon] SETTLED — id=${reconciliation.id} · venmo_tx=${txId || "(none)"}`);

  // Compute the human-readable week range for the push body
  const weekRange = formatWeekRange(
    new Date(reconciliation.week_start + "T12:00:00Z"),
    new Date(reconciliation.week_end + "T12:00:00Z"),
  );

  await logEmail({
    rawPayload,
    parsedSender: senderForLog,
    parsedAmount: amountForMatch,
    parsedNote: parsed.note || outgoingParsed?.note || null,
    parsedCode: code,
    parsedDirection: parserDirection,
    artistGhlId: reconciliation.artist_ghl_id,
    reconciliationId: reconciliation.id,
    decision: "settled",
    decisionNote: settleResult.alreadySettled
      ? "row was already settled (race or duplicate email) — idempotent"
      : `settled via venmo_auto · tx=${txId || "(none)"}`,
  });

  // Send the magic-moment push (skip if it was already settled — no double-pushing)
  if (!settleResult.alreadySettled) {
    try {
      await sendReconciliationSettledNotification({
        artistGhlUserId: reconciliation.artist_ghl_id,
        amount: Number(reconciliation.net_amount),
        weekRange,
        reconciliationId: reconciliation.id,
      });
    } catch (e) {
      console.error("  ⚠️ [Recon] settled push failed:", e.message);
    }
  }

  return {
    ok: true,
    decision: "settled",
    reconciliationId: reconciliation.id,
    weekRange,
    alreadySettled: settleResult.alreadySettled,
  };
}

module.exports = {
  handleReconciliationVenmoEmail,
  // exposed for testing / future use
  findReconciliationByCode,
  markSettled,
};
