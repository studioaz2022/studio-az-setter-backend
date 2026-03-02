/**
 * Venmo Email Parser
 *
 * Parses Venmo "paid you" notification emails forwarded via Hotmail → CloudMailin.
 * Extracts sender name, amount, note, date, and transaction ID from the email body.
 *
 * When forwarded via Hotmail, the plain text looks like:
 *   ________________________________
 *   From: Venmo <venmo@venmo.com>
 *   Sent: Sunday, March 1, 2026 5:41 PM
 *   Subject: Joshua Flores paid you $325.00
 *
 *   Joshua Flores paid you $325.00
 *   ...
 *   Transaction ID
 *   4543609756456913145
 *   ...
 */

/**
 * Parse a Venmo payment notification email.
 * @param {string} plain - Plain text body of the email
 * @param {string} html - HTML body of the email (fallback)
 * @param {string} emailDate - Date from email headers (ISO string or RFC 2822)
 * @returns {{ senderName: string, amount: number, note: string|null, date: Date|null, transactionId: string|null }}
 */
function parseVenmoEmail(plain, html, emailDate) {
  // Normalize \r\n to \n so regex patterns work consistently
  const rawText = (plain || stripHtml(html || "")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Strip Hotmail forwarding preamble to get the actual Venmo email body.
  // The forwarded email starts after the "Subject: ... paid you..." line.
  const text = stripForwardingHeaders(rawText);

  const result = {
    senderName: "",
    amount: 0,
    note: null,
    date: null,
    transactionId: null,
  };

  // Extract sender name — "NAME paid you" or "NAME paid your $X request"
  const paidYouMatch = text.match(/^(.+?)\s+paid you(?:r)?/im);
  if (paidYouMatch) {
    let name = paidYouMatch[1].trim();
    // Strip any residual forwarding header prefixes (Subject:, From:, etc.)
    name = name.replace(/^(?:Subject|From|To|Re|Fw|Fwd):\s*/i, "").trim();
    result.senderName = name;
  }

  // Extract amount — "$XXX.XX" (first occurrence after "paid you/your")
  const amountMatch = text.match(/paid you(?:r)?\s+\$([0-9,]+(?:\.\d{2})?)/i)
    || text.match(/\$([0-9,]+(?:\.\d{2})?)/);
  if (amountMatch) {
    result.amount = parseFloat(amountMatch[1].replace(/,/g, ""));
  }

  // Extract transaction ID — appears after "Transaction ID" label
  const txIdMatch = text.match(/Transaction ID\s*\n\s*(\d{10,})/i)
    || rawText.match(/Transaction ID\s*\n\s*(\d{10,})/i);
  if (txIdMatch) {
    result.transactionId = txIdMatch[1];
  }

  // Extract date+time — prefer "Sent:" line from forwarding headers (has time).
  // Format: "Sent: Sunday, March 1, 2026 5:41 PM"
  const sentMatch = rawText.match(/Sent:\s+\w+,\s+([A-Z][a-z]+ \d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  if (sentMatch) {
    const parsed = new Date(sentMatch[1]);
    if (!isNaN(parsed.getTime())) {
      result.date = parsed;
    }
  }

  // Fallback: body "Date\n\nMar 01, 2026" (no time, just date)
  if (!result.date) {
    const bodyDateMatch = text.match(/^Date\s*\n+\s*([A-Z][a-z]+ \d{1,2},?\s+\d{4})/m);
    if (bodyDateMatch) {
      const parsed = new Date(bodyDateMatch[1]);
      if (!isNaN(parsed.getTime())) {
        result.date = parsed;
      }
    }
  }

  // Last fallback: use CloudMailin email header date
  if (!result.date && emailDate) {
    const parsed = new Date(emailDate);
    if (!isNaN(parsed.getTime())) {
      result.date = parsed;
    }
  }

  // Extract note — look for lines that aren't Venmo boilerplate
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Skip Venmo boilerplate + split amount fragments ("$", "325", ".", "00")
  // Note: ^\d{1,2}\/\d{1,2}\/\d{2,4}$ matches standalone dates but NOT date ranges
  const skipPatterns =
    /paid you(?:r)?|^\$|^\d{1,6}$|^\.$|^[A-Z][a-z]+ \d{1,2},?\s+\d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$|^view|^reply|^venmo|^transfer|^standard|^instant|^https?:|^if you|^didn.t|^this is a|^request|^see transaction|^money credited|^transaction|^date$|^sent to|^@|^_+$|^\[|^for any|^paypal|^nmls|^for security|^from:|^sent:|^subject:|^to:|^cc:/i;

  for (const line of lines) {
    if (
      !skipPatterns.test(line) &&
      line !== result.senderName &&
      line.length > 1 &&
      line.length < 200
    ) {
      result.note = line;
      break;
    }
  }

  return result;
}

/**
 * Strip Hotmail/Outlook forwarding headers from the plain text body.
 * Finds the "Subject: ... paid you..." line and returns everything after it.
 * This isolates the actual Venmo email content from Hotmail's preamble.
 *
 * Hotmail may order the forwarding headers differently:
 *   Option A: From → Sent → Subject → body
 *   Option B: Subject → From → Sent → body
 * We strip everything up to and including the last forwarding header block.
 */
function stripForwardingHeaders(text) {
  // Strategy 1: Find "Subject: ... paid you..." line and strip up to the end of the forwarding block.
  // The forwarding block ends when we hit a blank line or the first "NAME paid you" body line.
  const subjectMatch = text.match(/Subject:\s+.+paid you(?:r)?[^\n]*/i);
  if (subjectMatch) {
    const afterSubject = text.slice(subjectMatch.index + subjectMatch[0].length);
    // Strip remaining forwarding headers (From:, Sent:, To:) that may follow
    const stripped = afterSubject.replace(/^\s*(?:From:|Sent:|To:|Date:|Cc:)[^\n]*\n/gim, "");
    return stripped.trim();
  }

  // Strategy 2: Look for a block of forwarding headers (From: + Sent: + Subject:) in any order.
  // Strip everything before the last header in the block.
  const headerBlock = text.match(/(?:^|\n)\s*(?:From:|Sent:|Subject:|To:|Date:)[^\n]*(?:\n\s*(?:From:|Sent:|Subject:|To:|Date:)[^\n]*)*/i);
  if (headerBlock) {
    const afterBlock = text.slice(headerBlock.index + headerBlock[0].length);
    return afterBlock.trim();
  }

  return text;
}

/**
 * Strip HTML tags to get plain text.
 */
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Generate a dedup key for a Venmo email payment.
 * Includes note to handle same-day split payments (David's Pt1 + Pt2).
 */
function generateDedup(senderName, amount, date, note) {
  const dateStr = date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    : "unknown";
  const noteSlug = (note || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  return `venmo-email-${dateStr}-${senderName.toLowerCase().replace(/\s+/g, "-")}-${amount}-${noteSlug}`;
}

module.exports = { parseVenmoEmail, generateDedup, stripHtml };
