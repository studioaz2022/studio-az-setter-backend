// analyticsQueries.js
// SQL query functions for barber analytics metrics (Tier 1)
//
// Data sources:
//   - appointments: contact_id, assigned_user_id, calendar_id, start_time, end_time, status
//   - transactions: contact_id, artist_ghl_id, gross_amount, service_price, tip_amount, session_date
//   - barber_service_prices: calendar_id, service_type, barber_name

const { supabase } = require("../clients/supabaseClient");

// Service-type evaluation windows (days)
const EVALUATION_WINDOWS = {
  haircut: 45,
  haircut_beard: 45,
  beard_trim: 45,
  haircut_long_med: 75,
};
const DEFAULT_EVAL_WINDOW = 45;

// Completed appointment statuses
const COMPLETED_STATUSES = ["showed", "confirmed"];
// All booked statuses (for no-show/cancellation denominators)
const ALL_BOOKED_STATUSES = ["showed", "confirmed", "noshow", "cancelled"];

/**
 * Get the evaluation window in days for a service type.
 */
function getEvalWindow(serviceType) {
  return EVALUATION_WINDOWS[serviceType] || DEFAULT_EVAL_WINDOW;
}

/**
 * 1.1 Rebooking Rate (Service-Type Aware)
 *
 * For each completed appointment, determine if the client returned to the same barber.
 * Uses service-type evaluation windows to classify clients as pending/rebooked/not rebooked.
 *
 * Returns: { strict, forgiving, total, rebooked, pending, notRebooked }
 */
async function getRebookingRate(barberGhlId, locationId) {
  // Get all completed appointments for this barber, joined with service type
  const { data: appointments, error } = await supabase
    .from("appointments")
    .select("id, contact_id, calendar_id, start_time, status")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true });

  if (error) throw new Error(`Rebooking query failed: ${error.message}`);
  if (!appointments || appointments.length === 0) {
    return { strict: null, forgiving: null, total: 0, rebooked: 0, pending: 0, notRebooked: 0 };
  }

  // Load service type mappings
  const serviceTypeMap = await getServiceTypeMap();
  const now = new Date();

  // Group appointments by contact_id, ordered by time
  const byContact = {};
  for (const appt of appointments) {
    if (!byContact[appt.contact_id]) byContact[appt.contact_id] = [];
    byContact[appt.contact_id].push(appt);
  }

  let rebooked = 0;
  let pending = 0;
  let notRebooked = 0;

  // For each contact, look at their most recent appointment
  // and determine if they should be counted as rebooked, pending, or not rebooked
  for (const contactId of Object.keys(byContact)) {
    const contactAppts = byContact[contactId];

    if (contactAppts.length >= 2) {
      // Client has returned at least once — rebooked
      rebooked++;
      continue;
    }

    // Single appointment — check if they're still within evaluation window
    const lastAppt = contactAppts[contactAppts.length - 1];
    const serviceType = serviceTypeMap.get(lastAppt.calendar_id) || "haircut";
    const evalWindow = getEvalWindow(serviceType);
    const daysSince = daysBetween(new Date(lastAppt.start_time), now);

    if (daysSince <= evalWindow) {
      pending++;
    } else if (daysSince <= evalWindow * 2) {
      // Past evaluation window but within 2x — still pending for forgiving,
      // not rebooked for strict
      pending++;
    } else {
      notRebooked++;
    }
  }

  const total = rebooked + pending + notRebooked;
  const strict = total > 0 ? round((rebooked / total) * 100, 1) : null;
  const forgivingDenom = rebooked + notRebooked;
  const forgiving = forgivingDenom > 0 ? round((rebooked / forgivingDenom) * 100, 1) : null;

  return { strict, forgiving, total, rebooked, pending, notRebooked };
}

/**
 * 1.2 First-Visit Rebooking Rate (Service-Type Aware)
 *
 * Of clients whose first-ever appointment with this barber was completed,
 * what % came back for a second visit?
 *
 * Returns: { strict, forgiving, total, rebooked, pending, notRebooked }
 */
async function getFirstVisitRebookingRate(barberGhlId, locationId) {
  const { data: appointments, error } = await supabase
    .from("appointments")
    .select("id, contact_id, calendar_id, start_time, status")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true });

  if (error) throw new Error(`First-visit rebooking query failed: ${error.message}`);
  if (!appointments || appointments.length === 0) {
    return { strict: null, forgiving: null, total: 0, rebooked: 0, pending: 0, notRebooked: 0 };
  }

  const serviceTypeMap = await getServiceTypeMap();
  const now = new Date();

  // Group by contact
  const byContact = {};
  for (const appt of appointments) {
    if (!byContact[appt.contact_id]) byContact[appt.contact_id] = [];
    byContact[appt.contact_id].push(appt);
  }

  let rebooked = 0;
  let pending = 0;
  let notRebooked = 0;

  for (const contactId of Object.keys(byContact)) {
    const contactAppts = byContact[contactId];
    const firstAppt = contactAppts[0];

    if (contactAppts.length >= 2) {
      rebooked++;
      continue;
    }

    // Single appointment — classify based on evaluation window of the first visit
    const serviceType = serviceTypeMap.get(firstAppt.calendar_id) || "haircut";
    const evalWindow = getEvalWindow(serviceType);
    const daysSince = daysBetween(new Date(firstAppt.start_time), now);

    if (daysSince <= evalWindow * 2) {
      pending++;
    } else {
      notRebooked++;
    }
  }

  const total = rebooked + pending + notRebooked;
  const strict = total > 0 ? round((rebooked / total) * 100, 1) : null;
  const forgivingDenom = rebooked + notRebooked;
  const forgiving = forgivingDenom > 0 ? round((rebooked / forgivingDenom) * 100, 1) : null;

  return { strict, forgiving, total, rebooked, pending, notRebooked };
}

/**
 * 1.3 Active Client Count (with New vs. Returning Breakdown)
 *
 * Unique clients with at least one completed appointment in the last 60 days.
 * - New: first-ever appointment with this barber is within the 60-day window
 * - Returning: 2+ lifetime appointments, with at least one in the window
 *
 * Returns: { total, newClients, returningClients }
 */
async function getActiveClientCount(barberGhlId, locationId) {
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  // Get ALL completed appointments for this barber (need lifetime data for new/returning split)
  const { data: allAppts, error } = await supabase
    .from("appointments")
    .select("contact_id, start_time")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true });

  if (error) throw new Error(`Active clients query failed: ${error.message}`);
  if (!allAppts || allAppts.length === 0) {
    return { total: 0, newClients: 0, returningClients: 0 };
  }

  // Find clients active in the last 60 days
  const activeContacts = new Set();
  const firstVisitByContact = {};

  for (const appt of allAppts) {
    if (!firstVisitByContact[appt.contact_id]) {
      firstVisitByContact[appt.contact_id] = new Date(appt.start_time);
    }
    if (new Date(appt.start_time) >= sixtyDaysAgo) {
      activeContacts.add(appt.contact_id);
    }
  }

  // Count lifetime visits per contact for active contacts
  const lifetimeVisits = {};
  for (const appt of allAppts) {
    if (activeContacts.has(appt.contact_id)) {
      lifetimeVisits[appt.contact_id] = (lifetimeVisits[appt.contact_id] || 0) + 1;
    }
  }

  let newClients = 0;
  let returningClients = 0;

  for (const contactId of activeContacts) {
    const firstVisit = firstVisitByContact[contactId];
    if (firstVisit >= sixtyDaysAgo) {
      newClients++;
    } else {
      returningClients++;
    }
  }

  return { total: activeContacts.size, newClients, returningClients };
}

/**
 * 1.4 Regulars Count (Service-Type Aware)
 *
 * Clients with 3+ lifetime completed appointments AND whose most recent visit
 * is within the 2x attrition threshold (not attrited).
 *
 * Returns: { count, totalBookings, regularBookingPercentage }
 */
async function getRegularsCount(barberGhlId, locationId) {
  const { data: appointments, error } = await supabase
    .from("appointments")
    .select("contact_id, calendar_id, start_time")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true });

  if (error) throw new Error(`Regulars query failed: ${error.message}`);
  if (!appointments || appointments.length === 0) {
    return { count: 0, totalBookings: 0, regularBookingPercentage: null };
  }

  const serviceTypeMap = await getServiceTypeMap();
  const now = new Date();

  // Group by contact
  const byContact = {};
  for (const appt of appointments) {
    if (!byContact[appt.contact_id]) byContact[appt.contact_id] = [];
    byContact[appt.contact_id].push(appt);
  }

  let regularsCount = 0;
  let regularsBookings = 0;

  for (const contactId of Object.keys(byContact)) {
    const contactAppts = byContact[contactId];

    if (contactAppts.length < 3) continue;

    // Check if most recent visit is within 2x evaluation window
    const lastAppt = contactAppts[contactAppts.length - 1];
    const serviceType = serviceTypeMap.get(lastAppt.calendar_id) || "haircut";
    const evalWindow = getEvalWindow(serviceType);
    const daysSince = daysBetween(new Date(lastAppt.start_time), now);

    if (daysSince <= evalWindow * 2) {
      regularsCount++;
      regularsBookings += contactAppts.length;
    }
  }

  const totalBookings = appointments.length;
  const regularBookingPercentage = totalBookings > 0
    ? round((regularsBookings / totalBookings) * 100, 1)
    : null;

  return { count: regularsCount, totalBookings, regularBookingPercentage };
}

/**
 * 1.5 Average Revenue Per Visit
 *
 * (total service revenue + tips) / total completed appointments for the period.
 * Supports flexible period via `periodDays` parameter.
 *
 * Returns: { avgRevenue, totalRevenue, appointmentCount }
 */
async function getAvgRevenuePerVisit(barberGhlId, locationId, periodDays = 30) {
  const startDate = getStartDate(periodDays);

  const { data: transactions, error } = await supabase
    .from("transactions")
    .select("gross_amount, tip_amount")
    .eq("artist_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .in("transaction_type", ["session_payment"])
    .gte("session_date", startDate);

  if (error) throw new Error(`Avg revenue query failed: ${error.message}`);
  if (!transactions || transactions.length === 0) {
    return { avgRevenue: null, totalRevenue: 0, appointmentCount: 0 };
  }

  let totalRevenue = 0;
  for (const t of transactions) {
    totalRevenue += parseFloat(t.gross_amount || 0);
  }

  const appointmentCount = transactions.length;
  const avgRevenue = round(totalRevenue / appointmentCount, 2);

  return { avgRevenue, totalRevenue: round(totalRevenue, 2), appointmentCount };
}

/**
 * 1.6 Average Tip Percentage
 *
 * AVG(tip_amount / service_price * 100) across tipped transactions.
 * Supports flexible period via `periodDays` parameter.
 *
 * Returns: { avgTipPercentage, tippedCount, totalCount }
 */
async function getAvgTipPercentage(barberGhlId, locationId, periodDays = 30) {
  const startDate = getStartDate(periodDays);

  const { data: transactions, error } = await supabase
    .from("transactions")
    .select("tip_amount, service_price")
    .eq("artist_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .in("transaction_type", ["session_payment"])
    .gte("session_date", startDate);

  if (error) throw new Error(`Avg tip query failed: ${error.message}`);
  if (!transactions || transactions.length === 0) {
    return { avgTipPercentage: null, tippedCount: 0, totalCount: 0 };
  }

  const tipPercentages = [];
  let totalCount = transactions.length;

  for (const t of transactions) {
    const tip = parseFloat(t.tip_amount || 0);
    const price = parseFloat(t.service_price || 0);

    if (tip > 0 && price > 0) {
      tipPercentages.push((tip / price) * 100);
    }
  }

  const tippedCount = tipPercentages.length;
  const avgTipPercentage = tippedCount > 0
    ? round(tipPercentages.reduce((sum, p) => sum + p, 0) / tippedCount, 1)
    : null;

  return { avgTipPercentage, tippedCount, totalCount };
}

/**
 * 1.7 No-Show Rate
 *
 * appointments with status 'noshow' / total booked appointments for the period.
 * Includes repeat offenders list (clients with 2+ no-shows).
 * Supports flexible period via `periodDays` parameter.
 *
 * Returns: { rate, noShowCount, totalBooked, repeatOffenders }
 */
async function getNoShowRate(barberGhlId, locationId, periodDays = 30) {
  const startDate = getStartDate(periodDays);

  const { data: appointments, error } = await supabase
    .from("appointments")
    .select("id, contact_id, start_time, status, title")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", ALL_BOOKED_STATUSES)
    .gte("start_time", new Date(startDate + "T00:00:00Z").toISOString());

  if (error) throw new Error(`No-show rate query failed: ${error.message}`);
  if (!appointments || appointments.length === 0) {
    return { rate: null, noShowCount: 0, totalBooked: 0, repeatOffenders: [] };
  }

  const totalBooked = appointments.length;
  const noShows = appointments.filter(a => a.status === "noshow");
  const noShowCount = noShows.length;
  const rate = round((noShowCount / totalBooked) * 100, 1);

  // Repeat offenders: clients with 2+ no-shows
  const noShowsByContact = {};
  for (const appt of noShows) {
    if (!appt.contact_id) continue;
    if (!noShowsByContact[appt.contact_id]) {
      noShowsByContact[appt.contact_id] = {
        contactId: appt.contact_id,
        contactName: extractContactName(appt.title),
        count: 0,
        lastOccurrence: null,
      };
    }
    noShowsByContact[appt.contact_id].count++;
    const apptDate = new Date(appt.start_time);
    if (!noShowsByContact[appt.contact_id].lastOccurrence ||
        apptDate > new Date(noShowsByContact[appt.contact_id].lastOccurrence)) {
      noShowsByContact[appt.contact_id].lastOccurrence = appt.start_time;
    }
  }

  const repeatOffenders = Object.values(noShowsByContact)
    .filter(o => o.count >= 2)
    .sort((a, b) => b.count - a.count);

  return { rate, noShowCount, totalBooked, repeatOffenders };
}

/**
 * 1.8 Cancellation Rate
 *
 * appointments with status 'cancelled' / total booked appointments for the period.
 * Includes repeat offenders list (clients with 2+ cancellations).
 * Supports flexible period via `periodDays` parameter.
 *
 * Returns: { rate, cancelledCount, totalBooked, repeatOffenders }
 */
async function getCancellationRate(barberGhlId, locationId, periodDays = 30) {
  const startDate = getStartDate(periodDays);

  const { data: appointments, error } = await supabase
    .from("appointments")
    .select("id, contact_id, start_time, status, title")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", ALL_BOOKED_STATUSES)
    .gte("start_time", new Date(startDate + "T00:00:00Z").toISOString());

  if (error) throw new Error(`Cancellation rate query failed: ${error.message}`);
  if (!appointments || appointments.length === 0) {
    return { rate: null, cancelledCount: 0, totalBooked: 0, repeatOffenders: [] };
  }

  const totalBooked = appointments.length;
  const cancelled = appointments.filter(a => a.status === "cancelled");
  const cancelledCount = cancelled.length;
  const rate = round((cancelledCount / totalBooked) * 100, 1);

  // Repeat offenders: clients with 2+ cancellations
  const cancelsByContact = {};
  for (const appt of cancelled) {
    if (!appt.contact_id) continue;
    if (!cancelsByContact[appt.contact_id]) {
      cancelsByContact[appt.contact_id] = {
        contactId: appt.contact_id,
        contactName: extractContactName(appt.title),
        count: 0,
        lastOccurrence: null,
      };
    }
    cancelsByContact[appt.contact_id].count++;
    const apptDate = new Date(appt.start_time);
    if (!cancelsByContact[appt.contact_id].lastOccurrence ||
        apptDate > new Date(cancelsByContact[appt.contact_id].lastOccurrence)) {
      cancelsByContact[appt.contact_id].lastOccurrence = appt.start_time;
    }
  }

  const repeatOffenders = Object.values(cancelsByContact)
    .filter(o => o.count >= 2)
    .sort((a, b) => b.count - a.count);

  return { rate, cancelledCount, totalBooked, repeatOffenders };
}

/**
 * Fetch all Tier 1 metrics in one call.
 * Returns the complete health check data.
 */
async function getHealthCheck(barberGhlId, locationId, periodDays = 30) {
  const [
    rebooking,
    firstVisitRebooking,
    activeClients,
    regulars,
    avgRevenue,
    avgTip,
    noShow,
    cancellation,
  ] = await Promise.all([
    getRebookingRate(barberGhlId, locationId),
    getFirstVisitRebookingRate(barberGhlId, locationId),
    getActiveClientCount(barberGhlId, locationId),
    getRegularsCount(barberGhlId, locationId),
    getAvgRevenuePerVisit(barberGhlId, locationId, periodDays),
    getAvgTipPercentage(barberGhlId, locationId, periodDays),
    getNoShowRate(barberGhlId, locationId, periodDays),
    getCancellationRate(barberGhlId, locationId, periodDays),
  ]);

  return {
    rebookingRate: rebooking,
    firstVisitRebookingRate: firstVisitRebooking,
    activeClients,
    regulars,
    avgRevenuePerVisit: avgRevenue,
    avgTipPercentage: avgTip,
    noShowRate: noShow,
    cancellationRate: cancellation,
  };
}

// ──────────────────────────────────────
// Helper functions
// ──────────────────────────────────────

/** Cache for service_type map (calendar_id → service_type) */
let serviceTypeCache = null;
let serviceTypeCacheExpiry = 0;
const SERVICE_TYPE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getServiceTypeMap() {
  const now = Date.now();
  if (serviceTypeCache && now < serviceTypeCacheExpiry) return serviceTypeCache;

  if (!supabase) {
    serviceTypeCache = new Map();
    serviceTypeCacheExpiry = now + SERVICE_TYPE_CACHE_TTL;
    return serviceTypeCache;
  }

  const { data, error } = await supabase
    .from("barber_service_prices")
    .select("calendar_id, service_type");

  if (error) {
    console.error("[Analytics] Failed to load service types:", error.message);
    serviceTypeCache = serviceTypeCache || new Map();
    return serviceTypeCache;
  }

  const map = new Map();
  for (const row of data || []) {
    map.set(row.calendar_id, row.service_type);
  }

  serviceTypeCache = map;
  serviceTypeCacheExpiry = now + SERVICE_TYPE_CACHE_TTL;
  return map;
}

/**
 * Calculate days between two dates.
 */
function daysBetween(d1, d2) {
  const ms = Math.abs(d2.getTime() - d1.getTime());
  return ms / (1000 * 60 * 60 * 24);
}

/**
 * Round a number to N decimal places.
 */
function round(num, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(num * factor) / factor;
}

/**
 * Get a start date string (YYYY-MM-DD) for a period in days.
 * Supports special values: "ytd" for year-to-date.
 */
function getStartDate(periodDays) {
  if (periodDays === "ytd") {
    const now = new Date();
    return `${now.getFullYear()}-01-01`;
  }

  const d = new Date();
  d.setDate(d.getDate() - periodDays);
  return d.toISOString().split("T")[0];
}

/**
 * Extract a contact name from the appointment title.
 * GHL appointment titles are typically like "Haircut w/ Drew - John Smith"
 * or just the contact name.
 */
function extractContactName(title) {
  if (!title) return "Unknown";
  // If title contains " - ", take the part after it (usually the contact name)
  const dashIdx = title.lastIndexOf(" - ");
  if (dashIdx !== -1) {
    return title.substring(dashIdx + 3).trim() || title;
  }
  return title;
}

/**
 * Parse the ?period= query parameter into periodDays.
 * Accepts: "7d", "30d", "90d", "ytd"
 * Defaults to 30 days.
 */
function parsePeriod(periodParam) {
  if (!periodParam) return 30;
  const lower = periodParam.toLowerCase();
  if (lower === "ytd") return "ytd";
  const match = lower.match(/^(\d+)d$/);
  if (match) return parseInt(match[1], 10);
  return 30;
}

module.exports = {
  getRebookingRate,
  getFirstVisitRebookingRate,
  getActiveClientCount,
  getRegularsCount,
  getAvgRevenuePerVisit,
  getAvgTipPercentage,
  getNoShowRate,
  getCancellationRate,
  getHealthCheck,
  parsePeriod,
  // Exported for testing
  getServiceTypeMap,
  EVALUATION_WINDOWS,
  DEFAULT_EVAL_WINDOW,
  COMPLETED_STATUSES,
  ALL_BOOKED_STATUSES,
};
