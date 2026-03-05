/**
 * Tenant Matching & Week Attribution
 *
 * Ported from rent-tracker/scripts/import-venmo.ts for real-time webhook use.
 * Matches Venmo sender names to tenants via alias map, and determines
 * which week a payment should be attributed to.
 */

// ─── Week Helpers (Monday-based) ────────────────────────────────────

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function weekOfDate(date) {
  return toISODate(getMonday(date));
}

function weeksBetween(w1, w2) {
  const d1 = new Date(w1 + "T00:00:00").getTime();
  const d2 = new Date(w2 + "T00:00:00").getTime();
  return Math.round((d2 - d1) / (7 * 24 * 60 * 60 * 1000));
}

// ─── Date Range Parser ──────────────────────────────────────────────

function parseDateRange(note, paymentDate) {
  if (!note) return null;

  const rangePattern = /(\d{1,2})\/(\d{1,2})\s*[-–]\s*[/]?(\d{1,2})\/(\d{1,2})/;
  const match = note.match(rangePattern);
  if (!match) return null;

  const startMonth = parseInt(match[1]);
  const startDay = parseInt(match[2]);
  const endMonth = parseInt(match[3]);
  const endDay = parseInt(match[4]);

  if (startDay > 31 || endDay > 31 || startMonth > 12 || endMonth > 12) return null;

  const paymentYear = paymentDate.getFullYear();
  const paymentMonth = paymentDate.getMonth() + 1;

  let endYear = paymentYear;
  let startYear = paymentYear;

  if (endMonth === 12 && paymentMonth <= 2) {
    endYear = paymentYear - 1;
    startYear = paymentYear - 1;
  } else if (startMonth > endMonth) {
    startYear = paymentYear - 1;
  }

  const startDate = new Date(startYear, startMonth - 1, startDay);
  const endDate = new Date(endYear, endMonth - 1, endDay);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return null;

  const paymentTime = paymentDate.getTime();
  const sixtyDays = 60 * 24 * 60 * 60 * 1000;
  if (Math.abs(startDate.getTime() - paymentTime) > sixtyDays) return null;
  if (Math.abs(endDate.getTime() - paymentTime) > sixtyDays) return null;

  return {
    startWeek: toISODate(getMonday(startDate)),
    endWeek: toISODate(getMonday(endDate)),
    startDate,
  };
}

// ─── Tenant Matching ────────────────────────────────────────────────

/**
 * Build a map of lowercase alias → tenant for fast lookup.
 * @param {Array} tenants - Array of tenant objects from InstantDB
 * @returns {Map<string, object>}
 */
function buildAliasMap(tenants) {
  const map = new Map();

  for (const t of tenants) {
    map.set(t.name.toLowerCase(), t);

    if (t.venmoAliases) {
      try {
        const aliases = JSON.parse(t.venmoAliases);
        for (const alias of aliases) {
          map.set(alias.toLowerCase(), t);
        }
      } catch {
        // not valid JSON, skip
      }
    }
  }

  return map;
}

/**
 * Match a Venmo sender name to a tenant.
 * @param {string} fromName - The sender's name from Venmo
 * @param {Map<string, object>} aliasMap - Alias map from buildAliasMap()
 * @returns {object|null} - Matched tenant or null
 */
function matchTenant(fromName, aliasMap) {
  const key = fromName.toLowerCase().trim();

  // Exact match
  if (aliasMap.has(key)) return aliasMap.get(key);

  // Try removing middle initials (e.g., "Albe A Herrera" → "Albe Herrera")
  const parts = key.split(/\s+/);
  if (parts.length > 2) {
    const firstLast = `${parts[0]} ${parts[parts.length - 1]}`;
    if (aliasMap.has(firstLast)) return aliasMap.get(firstLast);
  }

  // First name match — only if input is a single name and matches exactly one tenant
  if (parts.length === 1) {
    const firstName = parts[0];
    const firstNameMatches = [];
    for (const [alias, tenant] of aliasMap) {
      if (alias.split(/\s+/)[0] === firstName) {
        if (!firstNameMatches.find((t) => t.id === tenant.id)) {
          firstNameMatches.push(tenant);
        }
      }
    }
    if (firstNameMatches.length === 1) return firstNameMatches[0];
  }

  return null;
}

// ─── Week Attribution ───────────────────────────────────────────────

/**
 * Determine which week a payment should be attributed to.
 *
 * @param {number} amount - Payment amount
 * @param {string|null} note - Venmo note text
 * @param {Date} paymentDate - When the payment was made
 * @param {object} tenant - Tenant object
 * @param {string[]} [paidWeeks] - Weeks this tenant already has payments for (ISO date strings)
 * @returns {{ weekOf: string, attribution: string }}
 */
function attributeToWeek(amount, note, paymentDate, tenant, paidWeeks) {
  const paymentWeek = weekOfDate(paymentDate);

  // Tattoo artists / non-rent: just use payment date's week
  if (tenant.location === "tattoo" || tenant.paymentModel !== "rent") {
    return { weekOf: paymentWeek, attribution: "payment-date" };
  }

  const rent = tenant.rentAmount || 0;
  if (rent <= 0) {
    return { weekOf: paymentWeek, attribution: "payment-date" };
  }

  // Try to parse date range from note
  const dateRange = parseDateRange(note, paymentDate);

  if (dateRange) {
    const numWeeksSpanned = weeksBetween(dateRange.startWeek, dateRange.endWeek) + 1;

    if (numWeeksSpanned === 1) {
      return { weekOf: dateRange.endWeek, attribution: `note-range → ${dateRange.endWeek}` };
    }

    // Multi-week range but amount ≈ one week's rent — use best week
    if (numWeeksSpanned > 1 && numWeeksSpanned <= 4 && Math.abs(amount - rent) <= 10) {
      let bestWeek = dateRange.startWeek;
      // Saturday rule: if start date is Saturday (last day of its week), use endWeek
      if (dateRange.startDate && dateRange.startDate.getDay() === 6) {
        bestWeek = dateRange.endWeek;
      }
      return { weekOf: bestWeek, attribution: `note-range → ${bestWeek}` };
    }
  }

  // Late payment detection: if amount ≈ rent and we have payment history,
  // find the earliest unpaid week going back up to 4 weeks
  if (paidWeeks && paidWeeks.length >= 0 && Math.abs(amount - rent) <= 10) {
    const paidSet = new Set(paidWeeks);
    const monday = getMonday(paymentDate);

    // Check from 4 weeks ago up to the current payment week
    for (let i = 4; i >= 0; i--) {
      const checkDate = new Date(monday);
      checkDate.setDate(checkDate.getDate() - i * 7);
      const checkWeek = toISODate(checkDate);
      if (!paidSet.has(checkWeek)) {
        if (checkWeek !== paymentWeek) {
          return { weekOf: checkWeek, attribution: `backfill-unpaid → ${checkWeek}` };
        }
        // Earliest unpaid is the current week — just use it
        return { weekOf: paymentWeek, attribution: "payment-date" };
      }
    }
  }

  // Default: use payment date's week
  return { weekOf: paymentWeek, attribution: "payment-date" };
}

/**
 * Determine payment type based on tenant.
 */
function getPaymentType(tenant) {
  if (tenant.location === "tattoo") return "commission";
  if (tenant.paymentModel === "rent") return "rent";
  return "service";
}

module.exports = {
  buildAliasMap,
  matchTenant,
  attributeToWeek,
  getPaymentType,
  weekOfDate,
  toISODate,
  getMonday,
  parseDateRange,
};
