/**
 * Reconciliation Venmo Parser (Phase 5)
 *
 * Sits in front of the rent tracker Venmo email handler. Detects whether an
 * incoming Venmo email is a tattoo-finance reconciliation payment and, if so,
 * resolves it to a `reconciliations` row for idempotent settlement.
 *
 * Strict policy (per Phase 5 plan):
 *   - Auto-settle ONLY when [a:XXXNNNN] code matches an existing reconciliation
 *     AND amount matches within 1¢ AND direction is consistent.
 *   - Anything else → defer with a "please confirm" notification.
 *
 * Two parser paths for the two directions:
 *   - INCOMING ("paid you"): the existing rent tracker parser already handles
 *     this format. Used when shop_owes_artist (artist's inbox forwards
 *     "Lionel Chavez paid you $X") OR when artist_owes_shop (Lionel's inbox
 *     forwards "{artist} paid you $X").
 *   - OUTGOING ("You paid"): added here as a supplement. Used when Lionel's
 *     inbox forwards a Venmo "You paid {artist} $X" notification (his
 *     outgoing payment confirmation).
 *
 * See TATTOO_FINANCE_PLAN.md Phase 5.
 */

const { stripHtml } = require("../rentTracker/venmoEmailParser");

/**
 * Pull the reconciliation code marker from a note string.
 * Match patterns:
 *   [a:CHA0427]      — regular weekly recon
 *   [a:CHA0427-2]    — collision suffix (rare, when two artists share prefix)
 *   [a:CHA0527-R]    — Phase 8 rollup recon (consolidates multiple weekly recons)
 *   [a:CHA0527-R2]   — Phase 8 rollup with collision suffix
 * @returns {string|null} the code (e.g. "CHA0427"), or null if absent.
 */
function parseReconciliationCode(noteOrText) {
  if (!noteOrText) return null;
  const m = String(noteOrText).match(/\[a:([A-Z]{3}\d{4}(?:-(?:R\d*|\d+))?)\]/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Returns true if the email body looks like a reconciliation payment based on
 * surface markers — either the [a:XXXNNNN] code or the literal "StudioAZ Recon"
 * tag. Used to decide whether to route to the recon handler vs. the rent tracker.
 */
function looksLikeReconciliation(noteOrText) {
  if (!noteOrText) return false;
  const text = String(noteOrText);
  if (parseReconciliationCode(text)) return true;
  if (/StudioAZ\s+Recon/i.test(text)) return true;
  return false;
}

/**
 * Decode a reconciliation code into its parts. Loose validation only — the
 * authoritative match is done via DB lookup on the venmo_code UNIQUE column.
 * @returns {{ artistPrefix: string, monthDay: string, suffix: string|null }|null}
 */
function decodeReconciliationCode(code) {
  if (!code) return null;
  const m = String(code)
    .toUpperCase()
    .match(/^([A-Z]{3})(\d{4})(?:-(\d+))?$/);
  if (!m) return null;
  return {
    artistPrefix: m[1],
    monthDay: m[2],
    suffix: m[3] || null,
  };
}

/**
 * Parse an OUTGOING Venmo email forwarded from Lionel's inbox.
 *
 * Venmo's outgoing-payment confirmation emails have the subject pattern:
 *   "You paid {recipient} $X" or "You completed a Venmo payment to {recipient}"
 *
 * The body typically reads:
 *   "You paid {recipient} $X.XX"
 *   "Note: <whatever Lionel typed>"
 *   "Transaction ID: 1234567890"
 *
 * Returns the same shape as parseVenmoEmail() but with a `direction: "outgoing"`
 * flag. `senderName` here is the OWNER (Lionel) and `recipientName` is the
 * artist who received the money.
 *
 * @param {string} plain
 * @param {string} html
 * @param {string} emailDate
 * @returns {{
 *   direction: "outgoing",
 *   ownerName: string,
 *   recipientName: string,
 *   amount: number,
 *   note: string|null,
 *   date: Date|null,
 *   transactionId: string|null,
 * }|null}
 */
function parseOutgoingVenmoEmail(plain, html, emailDate) {
  const rawText = (plain || stripHtml(html || ""))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // Look for the "You paid {recipient} $X" pattern.
  // Allow for forwarding header noise — match anywhere, not just line start.
  // Also handle "You completed a Venmo payment to {recipient}" alternate format.
  let recipientMatch = rawText.match(/You paid\s+(.+?)\s+\$([0-9,]+(?:\.\d{2})?)/i);
  let recipient = null;
  let amount = 0;
  if (recipientMatch) {
    recipient = recipientMatch[1].trim();
    amount = parseFloat(recipientMatch[2].replace(/,/g, ""));
  } else {
    const altMatch = rawText.match(
      /You\s+(?:completed|sent).+?(?:to|payment to)\s+(.+?)(?:\s+for|\s*\n|\.|$)/i,
    );
    if (altMatch) {
      recipient = altMatch[1].trim();
      // Find the dollar amount near this match
      const amountMatch = rawText.match(/\$([0-9,]+(?:\.\d{2})?)/);
      if (amountMatch) {
        amount = parseFloat(amountMatch[1].replace(/,/g, ""));
      }
    }
  }

  if (!recipient || !amount) return null;

  // Strip residual forwarding prefixes from the recipient name
  recipient = recipient.replace(/^(?:(?:Subject|From|To|Re|Fw|Fwd):\s*)+/i, "").trim();
  // Recipient may have trailing punctuation
  recipient = recipient.replace(/[.,;:]$/, "").trim();

  // Transaction ID
  let transactionId = null;
  const txIdMatch = rawText.match(/Transaction ID\s*[:\s]*\n?\s*(\d{10,})/i);
  if (txIdMatch) transactionId = txIdMatch[1];

  // Note — search for "Note:" line, OR scan for the [a:] code anywhere
  let note = null;
  const noteLineMatch = rawText.match(/^[\s>]*Note\s*[:：]\s*(.+)$/im);
  if (noteLineMatch) {
    note = noteLineMatch[1].trim();
  }
  // Fallback: if there's a [a:XXXNNNN] anywhere in the body, grab that whole line
  if (!note) {
    const codeLineMatch = rawText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /\[a:[A-Z]{3}\d{4}/i.test(l));
    if (codeLineMatch) note = codeLineMatch;
  }

  // Date — try Sent: header, then email header
  let date = null;
  const sentRegex = /Sent:\s+\w+,\s+([A-Z][a-z]+ \d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/gi;
  let lastSentMatch = null;
  let sentM;
  while ((sentM = sentRegex.exec(rawText)) !== null) {
    lastSentMatch = sentM;
  }
  if (lastSentMatch) {
    const parsed = new Date(lastSentMatch[1] + " GMT-0500"); // CDT default; close enough for week attribution
    if (!isNaN(parsed.getTime())) date = parsed;
  }
  if (!date && emailDate) {
    const parsed = new Date(emailDate);
    if (!isNaN(parsed.getTime())) date = parsed;
  }

  return {
    direction: "outgoing",
    ownerName: "Leonel Chavez", // canonical owner display name; outgoing always sent by him
    recipientName: recipient,
    amount,
    note,
    date,
    transactionId,
  };
}

/**
 * Verify that the parties on the Venmo email match the reconciliation's direction.
 *
 * For shop_owes_artist (Lionel pays artist):
 *   - INCOMING email path: artist's inbox forwards "Lionel Chavez paid you $X"
 *     → senderName ≈ Lionel, recipient ≈ artist (the forwarder)
 *   - OUTGOING email path: Lionel's inbox forwards "You paid {artist} $X"
 *     → ownerName = Lionel, recipientName ≈ artist
 *
 * For artist_owes_shop (artist pays Lionel):
 *   - INCOMING email path: Lionel's inbox forwards "{artist} paid you $X"
 *     → senderName ≈ artist, recipient = Lionel (the forwarder)
 *   - OUTGOING email path: artist's inbox forwards "You paid Lionel Chavez $X"
 *     → ownerName = artist, recipientName ≈ Lionel
 *
 * @param {object} args
 * @param {"shop_owes_artist"|"artist_owes_shop"} args.reconDirection
 * @param {string} args.artistName  — artist's display name from `artist_settings`
 * @param {string} args.ownerVenmoName  — Lionel's Venmo display name (default "Leonel Chavez")
 * @param {object} args.parsed  — parseVenmoEmail() output (incoming) or parseOutgoingVenmoEmail() output
 * @param {"incoming"|"outgoing"} args.parserDirection
 * @returns {{ ok: boolean, reason: string|null }}
 */
function verifyDirection({
  reconDirection,
  artistName,
  ownerVenmoName,
  parsed,
  parserDirection,
}) {
  const owner = (ownerVenmoName || "Leonel Chavez").toLowerCase().trim();
  const artist = (artistName || "").toLowerCase().trim();
  if (!artist) {
    return { ok: false, reason: "missing-artist-name" };
  }

  const containsAny = (haystack, needles) => {
    const h = (haystack || "").toLowerCase();
    return needles.some((n) => n && h.includes(n));
  };

  // Decompose names into tokens for fuzzy comparison (handles "Leonel" vs "Lionel" via first-token match)
  const ownerTokens = owner.split(/\s+/).filter(Boolean);
  const artistTokens = artist.split(/\s+/).filter(Boolean);

  const isOwner = (name) =>
    containsAny(name, ownerTokens) ||
    // first-name only match: "Leonel" or "Lionel" when full string is just the first
    (ownerTokens.length > 0 &&
      (name || "").toLowerCase().startsWith(ownerTokens[0]));

  const isArtist = (name) =>
    containsAny(name, artistTokens) ||
    (artistTokens.length > 0 &&
      (name || "").toLowerCase().startsWith(artistTokens[0]));

  if (parserDirection === "incoming") {
    // parsed.senderName is who sent the money (the email recipient receives it)
    if (reconDirection === "shop_owes_artist") {
      // Sender should be Lionel
      return isOwner(parsed.senderName)
        ? { ok: true, reason: null }
        : { ok: false, reason: `expected sender to be owner, got "${parsed.senderName}"` };
    } else {
      // artist_owes_shop: sender should be the artist
      return isArtist(parsed.senderName)
        ? { ok: true, reason: null }
        : { ok: false, reason: `expected sender to be artist, got "${parsed.senderName}"` };
    }
  }

  // parserDirection === "outgoing"
  // parsed.ownerName + parsed.recipientName
  if (reconDirection === "shop_owes_artist") {
    // Owner sent to artist
    return isArtist(parsed.recipientName)
      ? { ok: true, reason: null }
      : { ok: false, reason: `expected recipient to be artist, got "${parsed.recipientName}"` };
  } else {
    // artist_owes_shop: artist sent to owner — but parserDirection=outgoing means
    // the forwarder of THIS email is the artist (their own outgoing). Recipient should be owner.
    return isOwner(parsed.recipientName)
      ? { ok: true, reason: null }
      : { ok: false, reason: `expected recipient to be owner, got "${parsed.recipientName}"` };
  }
}

/**
 * Compare two amounts with 1¢ tolerance for rounding.
 */
function amountsMatch(a, b) {
  return Math.abs((a || 0) - (b || 0)) <= 0.01;
}

module.exports = {
  parseReconciliationCode,
  looksLikeReconciliation,
  decodeReconciliationCode,
  parseOutgoingVenmoEmail,
  verifyDirection,
  amountsMatch,
};
