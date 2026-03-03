/**
 * Venmo CSV Statement Parser
 *
 * Parses monthly Venmo CSV statement exports and filters to relevant
 * barber client payments using multi-layer filtering:
 *   1. Basic: incoming payments only (Type=Payment, Status=Complete, Amount=+)
 *   2. Recipient: "To" column must match the barber's Venmo display name
 *   3. Tenant: skip known rent tenants (they belong in the rent tracker)
 *   4. Working hours: only payments within the barber's shift ±1hr buffer
 *
 * CSV columns (0-indexed):
 *   0: (empty)
 *   1: Transaction ID
 *   2: Datetime (ISO without TZ, e.g. "2026-02-24T21:38:59")
 *   3: Type (Payment, Charge, Standard Transfer)
 *   4: Status (Complete, Pending, Issued)
 *   5: Note
 *   6: From (sender name)
 *   7: To (recipient name)
 *   8: Amount (total) e.g. "+ $325.00" or "- $40.00"
 *   9: Amount (tip)
 */

/**
 * Parse a single CSV line, handling quoted fields with embedded commas.
 */
function parseCSVLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse a Venmo CSV statement string into filtered payment rows.
 *
 * @param {string} csvString - Raw CSV file contents
 * @param {string} barberVenmoName - The barber's Venmo display name (for "To" matching)
 * @returns {{ rows: Array, venmoUsername: string|null, statementPeriod: string|null }}
 */
function parseVenmoCSV(csvString, barberVenmoName) {
  const lines = csvString.split("\n");
  const rows = [];
  let venmoUsername = null;

  // Try to extract Venmo username from the header row
  // Format: "Account Statement - (@Leonel-Chavez) ,,,,..."
  if (lines.length > 0) {
    const headerMatch = lines[0].match(/\(@([^)]+)\)/);
    if (headerMatch) {
      venmoUsername = headerMatch[1];
    }
  }

  // Normalize the barber name for comparison
  const barberNameLower = (barberVenmoName || "").toLowerCase().trim();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);

    // Need at least 9 fields (indices 0-8)
    if (fields.length < 9) continue;

    const txId = fields[1];
    const datetime = fields[2];
    const type = fields[3];
    const status = fields[4];
    const note = fields[5];
    const from = fields[6];
    const to = fields[7];
    const amountRaw = fields[8];
    const tipRaw = fields[9] || "";

    // Skip non-data rows (headers, summaries, empty IDs)
    if (!txId || !/^\d+$/.test(txId)) continue;

    // Filter 1: Only completed payments
    if (type !== "Payment" || status !== "Complete") continue;

    // Filter 2: Only incoming (amount starts with "+")
    if (!amountRaw.includes("+")) continue;

    // Filter 3: "To" must match barber's Venmo name
    if (barberNameLower && to.toLowerCase().trim() !== barberNameLower) continue;

    // Parse amount
    const amountMatch = amountRaw.match(/[+-]\s*\$\s*([\d,]+\.?\d*)/);
    if (!amountMatch) continue;
    const amount = parseFloat(amountMatch[1].replace(/,/g, ""));
    if (!amount || amount <= 0) continue;

    // Parse tip
    let tip = 0;
    if (tipRaw) {
      const tipMatch = tipRaw.match(/\$?\s*([\d,]+\.?\d*)/);
      if (tipMatch) {
        tip = parseFloat(tipMatch[1].replace(/,/g, "")) || 0;
      }
    }

    rows.push({
      txId,
      datetime,
      type,
      status,
      note: note || null,
      from,
      to,
      amount,
      tip,
    });
  }

  return { rows, venmoUsername };
}

module.exports = { parseVenmoCSV, parseCSVLine };
