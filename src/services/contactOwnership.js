// ============================================================================
// contactOwnership — keep a barbershop contact's OWNER equal to the barber
// the client is actually sitting with, and keep every past barber as a follower.
//
// WHY THIS EXISTS
// ---------------
// The GHL check-in workflow addresses its Internal Notification to the contact's
// Assigned User. Historically the kiosk only wrote the "Here" custom field and
// never touched ownership, so a client who booked with barber A in 2024 and
// switched to barber B still pinged A's LeadConnector app on every visit —
// forever. The workflow execution log reads "delivered" the whole time, because
// it WAS delivered; just to the wrong phone.
//
// So ownership has to be correct BEFORE "Here" is written. See the caller in
// server/app.js — the "Here" write is gated on this returning ok:true.
//
// FOLLOWERS ARE HISTORY, NOT A NOTIFICATION CHANNEL. In GHL only the owner is
// pushed; followers are not. That makes the follower list a free, append-only
// record of every barber who has ever cut this client, with no alert cost.
// ============================================================================

const { ghlBarber } = require("../clients/ghlMultiLocationSdk");

// GHL user IDs that must never become a contact owner or be recorded as a
// follower. Currently EMPTY on purpose: 'mf1uNeKFJ1hTl1ZEvwjW' (the "Studio AZ
// (Test)" service account) is still used as a live walk-in test barber, and
// blocking it here would make it untestable. Add it the same day that account
// is retired — kioskConfig.js flags the same account for removal.
const BLOCKED_USER_IDS = new Set([]);

/**
 * Make `barberUserId` the owner of `contactId`, demoting the outgoing owner to
 * a follower first so the relationship history survives the swap.
 *
 * Never throws — always resolves to a result object, so the caller can gate on
 * `ok` rather than wrapping this in a try/catch that might swallow a failure.
 *
 * Failure policy is deliberately asymmetric:
 *   - Reassigning the owner is NOTIFICATION-CRITICAL. If it fails we return
 *     ok:false and the caller must NOT write "Here" — a silent failure here is
 *     exactly the original bug (wrong barber notified, log says delivered).
 *   - Recording the follower is HISTORY-ONLY. If it fails we log loudly and
 *     still reassign, because losing one history entry is much cheaper than
 *     failing a check-in and leaving the right barber un-notified.
 *
 * @param {string} contactId     GHL contact ID
 * @param {string} barberUserId  GHL user ID of the barber they're here to see
 * @param {object} [opts]
 * @param {object} [opts.sdk]    SDK override (tests); defaults to ghlBarber
 * @returns {Promise<{
 *   ok: boolean, changed: boolean, previousOwner: string|null,
 *   followerAdded: boolean, reason: string, error?: string
 * }>}
 */
async function ensureOwnerIsCurrentBarber(contactId, barberUserId, opts = {}) {
  const sdk = opts.sdk || ghlBarber;
  const base = { changed: false, previousOwner: null, followerAdded: false };

  if (!sdk) {
    return { ...base, ok: false, reason: "no_sdk", error: "Barbershop GHL SDK not configured" };
  }
  if (!contactId || !barberUserId) {
    return { ...base, ok: false, reason: "bad_args", error: "contactId and barberUserId are required" };
  }
  // A blocked user may not take ownership, but that must not fail the check-in.
  if (BLOCKED_USER_IDS.has(barberUserId)) {
    return { ...base, ok: true, reason: "barber_blocked" };
  }

  // 1. Read the current owner.
  let currentOwner = null;
  try {
    const res = await sdk.contacts.getContact({ contactId });
    const contact = res?.contact || res;
    currentOwner = contact?.assignedTo || null;
  } catch (err) {
    return { ...base, ok: false, reason: "get_failed", error: `getContact failed: ${err.message}` };
  }

  // 2. Already correct — the common case. No writes, so we don't fire GHL's
  //    "assigned user changed" triggers on every single check-in.
  if (currentOwner === barberUserId) {
    return { ...base, ok: true, previousOwner: currentOwner, reason: "already_owner" };
  }

  // 3. Hand the contact to the barber they're actually seeing.
  //
  //    This MUST happen before the follower write, not after: GHL rejects
  //    addFollowers with 400 "Can not add user as follower since he is already
  //    the contact owner". The outgoing owner only becomes eligible to be a
  //    follower once they've been displaced. It also puts the
  //    notification-critical write first, so a crash between the two steps
  //    costs a history entry rather than a missed alert.
  try {
    await sdk.contacts.updateContact({ contactId }, { assignedTo: barberUserId });
  } catch (err) {
    return {
      ...base, ok: false, previousOwner: currentOwner,
      reason: "assign_failed", error: `assignedTo update failed: ${err.message}`,
    };
  }

  // 4. Record the displaced owner as a follower. Best-effort (see failure
  //    policy above) — the check-in already notifies correctly at this point.
  let followerAdded = false;
  if (currentOwner && !BLOCKED_USER_IDS.has(currentOwner)) {
    try {
      const followRes = await sdk.contacts.addFollowersContact(
        { contactId },
        { followers: [currentOwner] }
      );
      const added = followRes?.followersAdded;
      // Already-a-follower comes back with an empty followersAdded, which is a
      // success for our purposes — the history is on the record either way.
      followerAdded = Array.isArray(added) ? added.includes(currentOwner) : true;
    } catch (err) {
      console.error(
        `⚠️ [OWNERSHIP] Could not record ${currentOwner} as a follower of ${contactId} ` +
        `— ownership already moved, so the check-in still notifies the right barber:`,
        err.message
      );
    }
  }

  console.log(
    `🔄 [OWNERSHIP] ${contactId}: owner ${currentOwner || "(none)"} → ${barberUserId}` +
    (currentOwner ? ` (previous owner kept as follower: ${followerAdded})` : "")
  );

  return {
    ok: true, changed: true, previousOwner: currentOwner, followerAdded,
    reason: currentOwner ? "reassigned" : "assigned_unowned",
  };
}

module.exports = { ensureOwnerIsCurrentBarber, BLOCKED_USER_IDS };
