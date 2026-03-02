/**
 * Venmo Email Parser
 *
 * Parses Venmo "paid you" notification emails forwarded via CloudMailin.
 * Extracts sender name, amount, note, and date from the email body.
 */

/**
 * Parse a Venmo payment notification email.
 * @param {string} plain - Plain text body of the email
 * @param {string} html - HTML body of the email (fallback)
 * @param {string} emailDate - Date from email headers (ISO string or RFC 2822)
 * @returns {{ senderName: string, amount: number, note: string|null, date: Date|null }}
 */
function parseVenmoEmail(plain, html, emailDate) {
  const text = plain || stripHtml(html || "");

  const result = {
    senderName: "",
    amount: 0,
    note: null,
    date: null,
  };

  // Extract sender name — "NAME paid you"
  const paidYouMatch = text.match(/(.+?)\s+paid you/i);
  if (paidYouMatch) {
    result.senderName = paidYouMatch[1].trim();
  }

  // Extract amount — "$XXX.XX" (first occurrence after "paid you")
  const amountMatch = text.match(/paid you\s+\$([0-9,]+(?:\.\d{2})?)/i)
    || text.match(/\$([0-9,]+(?:\.\d{2})?)/);
  if (amountMatch) {
    result.amount = parseFloat(amountMatch[1].replace(/,/g, ""));
  }

  // Extract date — from email headers first, then body patterns
  if (emailDate) {
    const parsed = new Date(emailDate);
    if (!isNaN(parsed.getTime())) {
      result.date = parsed;
    }
  }
  if (!result.date) {
    const datePatterns = [
      /([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/,       // "Feb 24, 2026"
      /(\d{1,2}\/\d{1,2}\/\d{2,4})/,                   // "2/24/2026"
    ];
    for (const pattern of datePatterns) {
      const dateMatch = text.match(pattern);
      if (dateMatch) {
        const parsed = new Date(dateMatch[1]);
        if (!isNaN(parsed.getTime())) {
          result.date = parsed;
          break;
        }
      }
    }
  }

  // Extract note — look for lines that aren't Venmo boilerplate
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Skip Venmo boilerplate lines. Note: ^\d{1,2}\/\d{1,2}\/\d{2,4}$ matches
  // standalone dates like "2/24/2026" but NOT date ranges like "3/2 - 3/6 🪑"
  const skipPatterns =
    /paid you|^\$|^[A-Z][a-z]+ \d{1,2},?\s+\d{4}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$|^view|^reply|^venmo|^transfer|^standard|^instant|^https?:|^if you|^didn.t|^this is a/i;

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
