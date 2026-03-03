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
    // Strip any residual forwarding header prefixes (Subject:, From:, Fw:, etc.)
    // Handle chained prefixes like "Fw: Fw: Samuel" or "Subject: Fw: Samuel"
    name = name.replace(/^(?:(?:Subject|From|To|Re|Fw|Fwd):\s*)+/i, "").trim();
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

  // Extract date+time — prefer "Sent:" line from the LAST (deepest) forwarding header block.
  // When forwarded multiple times, there are multiple "Sent:" lines. The last one before
  // the Venmo body is the actual Venmo send date (e.g., Feb 24), not the forward date (e.g., Mar 2).
  // Format: "Sent: Sunday, March 1, 2026 5:41 PM"
  const sentRegex = /Sent:\s+\w+,\s+([A-Z][a-z]+ \d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/gi;
  let lastSentMatch = null;
  let sentM;
  while ((sentM = sentRegex.exec(rawText)) !== null) {
    lastSentMatch = sentM;
  }
  if (lastSentMatch) {
    const parsed = new Date(lastSentMatch[1]);
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
 * Returns just the Venmo email body content.
 *
 * IMPORTANT: Emails may be forwarded multiple times, creating nested headers:
 *   ________________________________
 *   From: Leonel Chavez <l.jchavez@hotmail.com>      ← outer forward (1st)
 *   Sent: Monday, March 2, 2026 5:29 PM
 *   Subject: Fw: Samuel Ruiz Plaza paid you $100.00
 *   ________________________________
 *   From: Leonel Chavez <l.jchavez@hotmail.com>      ← middle forward (2nd)
 *   Sent: Monday, March 2, 2026 12:21 AM
 *   Subject: Fw: Samuel Ruiz Plaza paid you $100.00
 *   ________________________________
 *   From: Venmo <venmo@venmo.com>                     ← actual Venmo email (deepest)
 *   Sent: Tuesday, February 24, 2026 3:38 PM
 *   Subject: Samuel Ruiz Plaza paid you $100.00
 *
 * We need the LAST (deepest) "Subject: ... paid you" block — the one from Venmo.
 */
function stripForwardingHeaders(text) {
  // Find ALL "Subject: ... paid you" lines, use the LAST one (deepest = actual Venmo email)
  const subjectRegex = /Subject:\s+(?:(?:Fw|Fwd|Re):\s*)*(.+paid you(?:r)?[^\n]*)/gi;
  let lastSubjectMatch = null;
  let match;
  while ((match = subjectRegex.exec(text)) !== null) {
    lastSubjectMatch = match;
  }

  if (lastSubjectMatch) {
    const afterSubject = text.slice(lastSubjectMatch.index + lastSubjectMatch[0].length);
    // Strip remaining forwarding headers (From:, Sent:, To:) that may follow
    const stripped = afterSubject.replace(/^\s*(?:From:|Sent:|To:|Date:|Cc:)[^\n]*\n/gim, "");
    return stripped.trim();
  }

  // Fallback: Look for a block of forwarding headers in any order, use the last one
  const headerBlockRegex = /(?:^|\n)\s*(?:From:|Sent:|Subject:|To:|Date:)[^\n]*(?:\n\s*(?:From:|Sent:|Subject:|To:|Date:)[^\n]*)*/gi;
  let lastBlock = null;
  while ((match = headerBlockRegex.exec(text)) !== null) {
    lastBlock = match;
  }
  if (lastBlock) {
    const afterBlock = text.slice(lastBlock.index + lastBlock[0].length);
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
