// analyticsQueries.js
// SQL query functions for barber analytics metrics (Tier 1)
//
// Data sources:
//   - appointments: contact_id, assigned_user_id, calendar_id, start_time, end_time, status
//   - transactions: contact_id, artist_ghl_id, gross_amount, service_price, tip_amount, session_date
//   - barber_service_prices: calendar_id, service_type, barber_name

const { supabase, fetchAllRows } = require("../clients/supabaseClient");

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
 * 1.1 Rebooking Rate (Non-Regulars Only, Rolling 90-Day Window)
 *
 * Only counts clients with < 3 lifetime appointments whose first visit
 * was within the last 90 days. Regulars (3+ visits) are excluded —
 * they're tracked by attrition rate.
 *
 * Returns: { strict, forgiving, total, rebooked, pending, notRebooked, nonRegularCount }
 */
async function getRebookingRate(barberGhlId, locationId, asOfDate = null) {
  // Get all completed appointments for this barber, joined with service type
  const { data: rawAppointments, error } = await fetchAllRows(supabase
    .from("appointments")
    .select("id, contact_id, calendar_id, start_time, status")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true }));

  if (error) throw new Error(`Rebooking query failed: ${error.message}`);
  if (!rawAppointments || rawAppointments.length === 0) {
    return { strict: null, forgiving: null, total: 0, rebooked: 0, pending: 0, notRebooked: 0, nonRegularCount: 0 };
  }

  // Filter out appointments after asOfDate for historical accuracy
  const appointments = asOfDate
    ? rawAppointments.filter(a => a.start_time <= asOfDate + "T23:59:59Z")
    : rawAppointments;
  if (appointments.length === 0) {
    return { strict: null, forgiving: null, total: 0, rebooked: 0, pending: 0, notRebooked: 0, nonRegularCount: 0 };
  }

  // Load service type mappings
  const serviceTypeMap = await getServiceTypeMap();
  const now = asOfDate ? new Date(asOfDate + "T23:59:59Z") : new Date();

  // 90-day window cutoff — only consider contacts whose first visit is within this window
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  // Group appointments by contact_id, ordered by time
  const byContact = {};
  for (const appt of appointments) {
    if (!byContact[appt.contact_id]) byContact[appt.contact_id] = [];
    byContact[appt.contact_id].push(appt);
  }

  let rebooked = 0;
  let pending = 0;
  let notRebooked = 0;

  // Per-service-type breakdown tracking
  const byServiceType = {};

  for (const contactId of Object.keys(byContact)) {
    const contactAppts = byContact[contactId];

    // SKIP regulars — they're tracked by attrition rate
    if (contactAppts.length >= 3) continue;

    // Only include contacts whose first visit is within the 90-day window
    const firstAppt = contactAppts[0];
    if (new Date(firstAppt.start_time) < ninetyDaysAgo) continue;

    const lastAppt = contactAppts[contactAppts.length - 1];
    const serviceType = serviceTypeMap.get(lastAppt.calendar_id) || "haircut";

    // Initialize service type bucket if needed
    if (!byServiceType[serviceType]) {
      byServiceType[serviceType] = { rebooked: 0, pending: 0, notRebooked: 0 };
    }

    if (contactAppts.length === 2) {
      // Came back once — rebooked
      rebooked++;
      byServiceType[serviceType].rebooked++;
    } else {
      // Single appointment — check eval window
      const evalWindow = getEvalWindow(serviceType);
      const daysSince = daysBetween(new Date(lastAppt.start_time), now);

      if (daysSince <= evalWindow * 2) {
        pending++;
        byServiceType[serviceType].pending++;
      } else {
        notRebooked++;
        byServiceType[serviceType].notRebooked++;
      }
    }
  }

  const total = rebooked + pending + notRebooked;
  const strict = total > 0 ? round((rebooked / total) * 100, 1) : null;
  const forgivingDenom = rebooked + notRebooked;
  const forgiving = forgivingDenom > 0 ? round((rebooked / forgivingDenom) * 100, 1) : null;

  // Compute per-service-type rates
  const serviceTypeBreakdown = {};
  for (const [st, counts] of Object.entries(byServiceType)) {
    const stTotal = counts.rebooked + counts.pending + counts.notRebooked;
    const stForgivingDenom = counts.rebooked + counts.notRebooked;
    serviceTypeBreakdown[st] = {
      strict: stTotal > 0 ? round((counts.rebooked / stTotal) * 100, 1) : null,
      forgiving: stForgivingDenom > 0 ? round((counts.rebooked / stForgivingDenom) * 100, 1) : null,
      total: stTotal,
      rebooked: counts.rebooked,
      pending: counts.pending,
      notRebooked: counts.notRebooked,
    };
  }

  return { strict, forgiving, total, rebooked, pending, notRebooked, nonRegularCount: total, serviceTypeBreakdown };
}

/**
 * 1.2 Active Client Count (with New vs. Returning Breakdown)
 *
 * Unique clients with at least one completed appointment in the last 60 days.
 * - New: first-ever appointment with this barber is within the 60-day window
 * - Returning: 2+ lifetime appointments, with at least one in the window
 *
 * Returns: { total, newClients, returningClients }
 */
async function getActiveClientCount(barberGhlId, locationId, asOfDate = null) {
  const ref = asOfDate ? new Date(asOfDate + "T23:59:59Z") : new Date();
  const sixtyDaysAgo = new Date(ref);
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  // Get ALL completed appointments for this barber (need lifetime data for new/returning split)
  const { data: rawAppts, error } = await fetchAllRows(supabase
    .from("appointments")
    .select("contact_id, start_time")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true }));

  if (error) throw new Error(`Active clients query failed: ${error.message}`);
  if (!rawAppts || rawAppts.length === 0) {
    return { total: 0, newClients: 0, returningClients: 0 };
  }

  // Filter out appointments after asOfDate for historical accuracy
  const allAppts = asOfDate
    ? rawAppts.filter(a => a.start_time <= asOfDate + "T23:59:59Z")
    : rawAppts;
  if (allAppts.length === 0) {
    return { total: 0, newClients: 0, returningClients: 0 };
  }

  // Find clients active in the last 60 days (relative to asOfDate or today)
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
async function getRegularsCount(barberGhlId, locationId, asOfDate = null) {
  const { data: rawAppointments, error } = await fetchAllRows(supabase
    .from("appointments")
    .select("contact_id, calendar_id, start_time")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true }));

  if (error) throw new Error(`Regulars query failed: ${error.message}`);
  if (!rawAppointments || rawAppointments.length === 0) {
    return { count: 0, totalBookings: 0, regularBookingPercentage: null };
  }

  // Filter out appointments after asOfDate for historical accuracy
  const appointments = asOfDate
    ? rawAppointments.filter(a => a.start_time <= asOfDate + "T23:59:59Z")
    : rawAppointments;
  if (appointments.length === 0) {
    return { count: 0, totalBookings: 0, regularBookingPercentage: null };
  }

  const serviceTypeMap = await getServiceTypeMap();
  const now = asOfDate ? new Date(asOfDate + "T23:59:59Z") : new Date();

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
async function getAvgRevenuePerVisit(barberGhlId, locationId, periodDays = 30, endDate = null, startDateOverride = null) {
  const startDate = startDateOverride || getStartDate(periodDays);

  let query = supabase
    .from("transactions")
    .select("gross_amount, service_price, tip_amount")
    .eq("artist_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .in("transaction_type", ["session_payment"])
    .gte("session_date", startDate);

  if (endDate) query = query.lt("session_date", endDate);

  const { data: transactions, error } = await query;

  if (error) throw new Error(`Avg revenue query failed: ${error.message}`);
  if (!transactions || transactions.length === 0) {
    return { avgRevenue: null, avgServiceRevenue: null, totalRevenue: 0, totalServiceRevenue: 0, totalTips: 0, appointmentCount: 0 };
  }

  let totalRevenue = 0;
  let totalServiceRevenue = 0;
  let totalTips = 0;
  for (const t of transactions) {
    totalRevenue += parseFloat(t.gross_amount || 0);
    totalServiceRevenue += parseFloat(t.service_price || 0);
    totalTips += parseFloat(t.tip_amount || 0);
  }

  const appointmentCount = transactions.length;
  const avgRevenue = round(totalRevenue / appointmentCount, 2);
  const avgServiceRevenue = round(totalServiceRevenue / appointmentCount, 2);

  return {
    avgRevenue,
    avgServiceRevenue,
    totalRevenue: round(totalRevenue, 2),
    totalServiceRevenue: round(totalServiceRevenue, 2),
    totalTips: round(totalTips, 2),
    appointmentCount,
  };
}

/**
 * 1.6 Average Tip Percentage
 *
 * AVG(tip_amount / service_price * 100) across tipped transactions.
 * Supports flexible period via `periodDays` parameter.
 *
 * Returns: { avgTipPercentage, tippedCount, totalCount }
 */
async function getAvgTipPercentage(barberGhlId, locationId, periodDays = 30, endDate = null, startDateOverride = null) {
  const startDate = startDateOverride || getStartDate(periodDays);

  let query = supabase
    .from("transactions")
    .select("tip_amount, service_price")
    .eq("artist_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .in("transaction_type", ["session_payment"])
    .gte("session_date", startDate);

  if (endDate) query = query.lt("session_date", endDate);

  const { data: transactions, error } = await query;

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
async function getNoShowRate(barberGhlId, locationId, periodDays = 30, endDate = null, startDateOverride = null) {
  const startDate = startDateOverride || getStartDate(periodDays);

  let query = supabase
    .from("appointments")
    .select("id, contact_id, start_time, status, title")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", ALL_BOOKED_STATUSES)
    .gte("start_time", new Date(startDate + "T00:00:00Z").toISOString())
    .limit(10000);

  if (endDate) query = query.lt("start_time", new Date(endDate + "T00:00:00Z").toISOString());

  const { data: appointments, error } = await query;

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
        contactName: null, // resolved below via batch lookup
        titleFallback: extractContactName(appt.title),
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

  // Batch-resolve contact names from client_financials
  const offenderContactIds = Object.keys(noShowsByContact);
  const nameMap = await getContactNames(offenderContactIds);
  for (const entry of Object.values(noShowsByContact)) {
    entry.contactName = nameMap.get(entry.contactId) || entry.titleFallback;
    delete entry.titleFallback;
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
async function getCancellationRate(barberGhlId, locationId, periodDays = 30, endDate = null, startDateOverride = null) {
  const startDate = startDateOverride || getStartDate(periodDays);

  let query = supabase
    .from("appointments")
    .select("id, contact_id, start_time, status, title")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", ALL_BOOKED_STATUSES)
    .gte("start_time", new Date(startDate + "T00:00:00Z").toISOString())
    .limit(10000);

  if (endDate) query = query.lt("start_time", new Date(endDate + "T00:00:00Z").toISOString());

  const { data: appointments, error } = await query;

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
        contactName: null, // resolved below via batch lookup
        titleFallback: extractContactName(appt.title),
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

  // Batch-resolve contact names from client_financials
  const offenderContactIds = Object.keys(cancelsByContact);
  const nameMap = await getContactNames(offenderContactIds);
  for (const entry of Object.values(cancelsByContact)) {
    entry.contactName = nameMap.get(entry.contactId) || entry.titleFallback;
    delete entry.titleFallback;
  }

  const repeatOffenders = Object.values(cancelsByContact)
    .filter(o => o.count >= 2)
    .sort((a, b) => b.count - a.count);

  return { rate, cancelledCount, totalBooked, repeatOffenders };
}

// ──────────────────────────────────────
// Tier 2 Metrics (Diagnostic)
// ──────────────────────────────────────

/**
 * 2.1 Client Attrition Rate (Service-Type Aware)
 *
 * Clients who have not returned past their service-type evaluation window.
 * Strict: clients past 1x window with no return are attrited
 * Forgiving: only clients past 2x window are attrited
 *
 * Returns: { strict, forgiving, atritedCount, atRiskCount, totalClients }
 */
async function getAttritionRate(barberGhlId, locationId, asOfDate = null) {
  const { data: rawAppointments, error } = await fetchAllRows(supabase
    .from("appointments")
    .select("contact_id, calendar_id, start_time")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true }));

  if (error) throw new Error(`Attrition query failed: ${error.message}`);
  if (!rawAppointments || rawAppointments.length === 0) {
    return { strict: null, forgiving: null, atritedCount: 0, atRiskCount: 0, totalClients: 0 };
  }

  // Filter out appointments after asOfDate for historical accuracy
  const appointments = asOfDate
    ? rawAppointments.filter(a => a.start_time <= asOfDate + "T23:59:59Z")
    : rawAppointments;
  if (appointments.length === 0) {
    return { strict: null, forgiving: null, atritedCount: 0, atRiskCount: 0, totalClients: 0 };
  }

  const serviceTypeMap = await getServiceTypeMap();
  const now = asOfDate ? new Date(asOfDate + "T23:59:59Z") : new Date();

  // Group by contact — take most recent appointment
  const byContact = {};
  for (const appt of appointments) {
    byContact[appt.contact_id] = appt; // last one wins since ordered ascending
  }

  let activeCount = 0;   // within 1x window
  let atRiskCount = 0;   // between 1x and 2x window
  let atritedCount = 0;  // past 2x window

  for (const contactId of Object.keys(byContact)) {
    const lastAppt = byContact[contactId];
    const serviceType = serviceTypeMap.get(lastAppt.calendar_id) || "haircut";
    const evalWindow = getEvalWindow(serviceType);
    const daysSince = daysBetween(new Date(lastAppt.start_time), now);

    if (daysSince <= evalWindow) {
      activeCount++;
    } else if (daysSince <= evalWindow * 2) {
      atRiskCount++;
    } else {
      atritedCount++;
    }
  }

  const totalClients = activeCount + atRiskCount + atritedCount;

  // Strict: pending (at-risk) counts as attrited
  const strictAttrited = atRiskCount + atritedCount;
  const strict = totalClients > 0 ? round((strictAttrited / totalClients) * 100, 1) : null;

  // Forgiving: only past 2x threshold
  const forgiving = totalClients > 0 ? round((atritedCount / totalClients) * 100, 1) : null;

  return { strict, forgiving, atritedCount, atRiskCount, totalClients };
}

/**
 * 2.2 New Client Trend (Weekly, 8-Week Sparkline)
 *
 * Count of unique clients whose first-ever appointment with this barber
 * falls in each week. Returns 8 weeks of data + 4-week moving average.
 *
 * Returns: { weeks: [{ weekStart, weekEnd, count }], movingAverage: number, total: number }
 */
async function getNewClientTrend(barberGhlId, locationId, numWeeks = 8, asOfDate = null) {
  // Get all completed appointments for this barber
  const { data: rawAppointments, error } = await fetchAllRows(supabase
    .from("appointments")
    .select("contact_id, start_time")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true }));

  if (error) throw new Error(`New client trend query failed: ${error.message}`);
  if (!rawAppointments || rawAppointments.length === 0) {
    return { weeks: [], movingAverage: null, total: 0 };
  }

  // Filter out appointments after asOfDate for historical accuracy
  const appointments = asOfDate
    ? rawAppointments.filter(a => a.start_time <= asOfDate + "T23:59:59Z")
    : rawAppointments;
  if (appointments.length === 0) {
    return { weeks: [], movingAverage: null, total: 0 };
  }

  // Find each contact's first appointment (MIN start_time)
  const firstVisitByContact = {};
  for (const appt of appointments) {
    if (!firstVisitByContact[appt.contact_id]) {
      firstVisitByContact[appt.contact_id] = new Date(appt.start_time);
    }
  }

  // Build week buckets (going back numWeeks from asOfDate or today)
  const now = asOfDate ? new Date(asOfDate + "T23:59:59Z") : new Date();
  const weeks = [];
  for (let i = numWeeks - 1; i >= 0; i--) {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - (i * 7));
    weekEnd.setHours(23, 59, 59, 999);

    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);

    weeks.push({
      weekStart: weekStart.toISOString().split("T")[0],
      weekEnd: weekEnd.toISOString().split("T")[0],
      count: 0,
    });
  }

  // Count new clients per week
  for (const firstVisit of Object.values(firstVisitByContact)) {
    for (const week of weeks) {
      const ws = new Date(week.weekStart);
      const we = new Date(week.weekEnd + "T23:59:59.999Z");
      if (firstVisit >= ws && firstVisit <= we) {
        week.count++;
        break;
      }
    }
  }

  // 4-week moving average (average of last 4 weeks)
  const last4 = weeks.slice(-4);
  const movingAverage = last4.length > 0
    ? round(last4.reduce((sum, w) => sum + w.count, 0) / last4.length, 1)
    : null;

  const total = weeks.reduce((sum, w) => sum + w.count, 0);

  return { weeks, movingAverage, total };
}

/**
 * 2.3 Chair Utilization
 *
 * Booked appointment hours / true available capacity for the period.
 *
 * Capacity is computed from GHL data:
 *   1. Fetch all schedules for the barber (one per calendar)
 *   2. Fetch calendar configs for slot duration/interval
 *   3. Fetch recurring blocking events (breaks, block slots) via Calendar Events API
 *   4. For each day, generate all bookable start times per calendar from the schedule
 *   5. Remove start times blocked by recurring events
 *   6. Union all HC (haircut) start times → HC capacity (30-min slots)
 *   7. H+B (haircut+beard) slots that extend beyond HC grid = break padding capacity
 *   8. Total capacity = HC slots × 30min + H+B extra minutes
 *
 * One chair = one client at a time. HC calendars define the primary grid;
 * H+B calendars only add capacity for minutes outside that grid (break paddings).
 *
 * Two modes:
 *   MODE 1 (live): Current/future week — Free Slots API + Calendar Events (most accurate)
 *   MODE 2 (historical): Past weeks — Calendar Events + calendar openHours
 *
 * Returns: { utilization, capacityMinutes, utilizedMinutes, freeSlotMinutes,
 *            appointmentCount, periodDays, mode,
 *            bookedHours, availableHours, byDayOfWeek, scheduleSource }
 */
async function getChairUtilization(barberGhlId, locationId, periodDays = 30, asOfDate = null) {
  const { BARBER_DATA } = require("../config/kioskConfig");

  let ghlBarber;
  try {
    ghlBarber = require("../clients/ghlMultiLocationSdk").ghlBarber;
  } catch (err) {
    console.warn("[ChairUtil] ghlBarber SDK not available:", err.message);
  }

  if (!ghlBarber) {
    return _emptyUtilization(periodDays);
  }

  // Get ALL calendar IDs for this barber (public + F&F) from schedules.
  // kioskConfig only has public-facing calendars, but F&F appointments use the same chair.
  const barberConfig = BARBER_DATA.find(b => b.ghlUserId === barberGhlId);
  const kioskCalendarIds = barberConfig?.calendars ? Object.values(barberConfig.calendars) : [];

  // Fetch all calendar IDs from the barber's schedules (includes F&F)
  let calendarIds = [...kioskCalendarIds];
  try {
    const httpClient = ghlBarber.getHttpClient();
    const schedResp = await httpClient.get(
      `/calendars/schedules/search?locationId=${locationId}&userId=${barberGhlId}`
    );
    const schedules = schedResp.data?.schedules || [];
    const schedCalIds = new Set();
    for (const s of schedules) {
      for (const calId of s.calendarIds || []) schedCalIds.add(calId);
    }
    // Merge: keep kioskConfig order, add any extra F&F calendars
    for (const calId of schedCalIds) {
      if (!calendarIds.includes(calId)) calendarIds.push(calId);
    }
  } catch (err) {
    console.warn(`[ChairUtil] Schedule calendar lookup failed: ${err.message}`);
  }

  if (calendarIds.length === 0) {
    console.warn(`[ChairUtil] No calendars found for barber ${barberGhlId}`);
    return _emptyUtilization(periodDays);
  }

  // Determine date range (Central time)
  const centralNow = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const endDateStr = asOfDate || centralNow;
  const startDate = getStartDate(periodDays, asOfDate);

  // Decide mode based on whether the range includes today
  const rangeIncludesToday = !asOfDate || asOfDate >= centralNow;
  const rangeStartsBeforeToday = startDate < centralNow;

  try {
    if (rangeIncludesToday && rangeStartsBeforeToday) {
      // HYBRID: past days use historical (openHours), today uses live (free slots)
      // Then merge the two results
      const yesterday = new Date(centralNow + "T12:00:00Z");
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayStr = yesterday.toISOString().split("T")[0];

      const [historical, live] = await Promise.all([
        startDate <= yesterdayStr
          ? _historicalUtilization(ghlBarber, barberGhlId, locationId, calendarIds, startDate, yesterdayStr, periodDays)
          : null,
        _liveUtilization(ghlBarber, barberGhlId, locationId, calendarIds, centralNow, endDateStr, periodDays),
      ]);

      if (!historical) {
        return live; // range starts today — no past days
      }

      // Merge: sum the minutes, recalculate utilization
      return _mergeUtilization(historical, live, periodDays);
    } else if (rangeIncludesToday) {
      // Range starts today or later — pure live mode
      return await _liveUtilization(ghlBarber, barberGhlId, locationId, calendarIds, startDate, endDateStr, periodDays);
    } else {
      // Entirely in the past — pure historical mode
      return await _historicalUtilization(ghlBarber, barberGhlId, locationId, calendarIds, startDate, endDateStr, periodDays);
    }
  } catch (err) {
    console.error(`[ChairUtil] Failed for ${barberGhlId}: ${err.message}`);
    return _emptyUtilization(periodDays);
  }
}

/** Empty return shape for when we can't compute. */
function _emptyUtilization(periodDays) {
  return {
    utilization: null, capacityMinutes: 0, utilizedMinutes: 0,
    freeSlotMinutes: 0, appointmentCount: 0, periodDays,
    mode: "unavailable",
    // Legacy fields for iOS diagnostics view
    bookedHours: 0, availableHours: 0, byDayOfWeek: {}, scheduleSource: "unavailable",
  };
}

/** Merge historical + live utilization results into a single combined result. */
function _mergeUtilization(historical, live, periodDays) {
  const capacityMinutes = historical.capacityMinutes + live.capacityMinutes;
  const utilizedMinutes = historical.utilizedMinutes + live.utilizedMinutes;
  const freeSlotMinutes = historical.freeSlotMinutes + live.freeSlotMinutes;
  const appointmentCount = historical.appointmentCount + live.appointmentCount;

  const utilization = capacityMinutes > 0
    ? round((utilizedMinutes / capacityMinutes) * 100, 1)
    : null;

  // Merge byDayOfWeek
  const byDayOfWeek = { ...historical.byDayOfWeek };
  for (const [day, data] of Object.entries(live.byDayOfWeek)) {
    if (byDayOfWeek[day]) {
      const totalMinutes = byDayOfWeek[day].avgBookedHours * byDayOfWeek[day].daysWorked * 60
        + data.avgBookedHours * data.daysWorked * 60;
      const totalDays = byDayOfWeek[day].daysWorked + data.daysWorked;
      byDayOfWeek[day] = {
        avgBookedHours: totalDays > 0 ? round(totalMinutes / totalDays / 60, 1) : 0,
        daysWorked: totalDays,
      };
    } else {
      byDayOfWeek[day] = data;
    }
  }

  return {
    utilization,
    capacityMinutes,
    utilizedMinutes,
    freeSlotMinutes,
    appointmentCount,
    periodDays,
    mode: "hybrid",
    bookedHours: round(utilizedMinutes / 60, 1),
    availableHours: round(capacityMinutes / 60, 1),
    byDayOfWeek,
    scheduleSource: "hybrid",
  };
}

/**
 * MODE 1 — Live: Free Slots API + Calendar Events.
 * Free Slots API returns actual bookable slots (already accounts for cross-calendar
 * conflicts, breaks, blocks, and existing bookings).
 *
 * capacity = free_slot_minutes + appointment_minutes
 * utilized = appointment_minutes
 */
async function _liveUtilization(ghlBarber, barberGhlId, locationId, calendarIds, startDate, endDateStr, periodDays) {
  const httpClient = ghlBarber.getHttpClient();

  // Build epoch ms for API calls.
  // Use Intl to get the correct UTC offset for Central time (CST=-06:00, CDT=-05:00).
  // Hardcoding -06:00 causes a 1-hour shift during CDT (Mar-Nov), bleeding queries
  // into adjacent days and inflating/misattributing capacity.
  const getCentralOffset = (dateStr) => {
    const d = new Date(dateStr + "T12:00:00Z");
    const utcStr = d.toLocaleString("en-US", { timeZone: "UTC" });
    const centralStr = d.toLocaleString("en-US", { timeZone: "America/Chicago" });
    return (new Date(utcStr) - new Date(centralStr)) / 60000; // offset in minutes
  };
  const offsetMin = getCentralOffset(startDate);
  const offsetHrs = Math.floor(Math.abs(offsetMin) / 60);
  const offsetMins = Math.abs(offsetMin) % 60;
  const offsetStr = `${offsetMin >= 0 ? "-" : "+"}${String(offsetHrs).padStart(2, "0")}:${String(offsetMins).padStart(2, "0")}`;
  const startMs = new Date(`${startDate}T00:00:00${offsetStr}`).getTime();
  const endMs = new Date(`${endDateStr}T23:59:59${offsetStr}`).getTime();

  // 1. Fetch free slots for each calendar, union by start time
  const allFreeSlots = new Map(); // startTimeStr → durationMinutes (deduplicate overlaps)

  for (const calId of calendarIds) {
    try {
      const resp = await ghlBarber.calendars.getSlots({
        calendarId: calId,
        startDate: startMs.toString(),
        endDate: endMs.toString(),
        timezone: "America/Chicago",
      });

      // Response: { {date}: { slots: [{ slot: "2025-03-10T09:00:00-05:00" }, ...] } }
      const slotData = resp || {};
      for (const [dateKey, dayData] of Object.entries(slotData)) {
        if (dateKey.startsWith("_") || !dayData?.slots) continue;
        for (const s of dayData.slots) {
          const slotTime = s.slot;
          if (!slotTime) continue;
          // Deduplicate: same start time across calendars = one slot
          if (!allFreeSlots.has(slotTime)) {
            allFreeSlots.set(slotTime, calId);
          }
        }
      }
    } catch (err) {
      console.warn(`[ChairUtil Live] Free slots failed for calendar ${calId}: ${err.message}`);
    }
  }

  // 2. Fetch calendar configs to get slot durations per calendar
  const calSlotDurations = {};
  for (const calId of calendarIds) {
    try {
      const calResp = await ghlBarber.calendars.getCalendar({ calendarId: calId });
      const cal = calResp?.calendar || calResp;
      calSlotDurations[calId] = cal?.slotDuration || 30;
    } catch (err) {
      calSlotDurations[calId] = 30; // default
    }
  }

  // Compute free slot minutes: for each slot, use the min slot duration across calendars
  // Since we deduplicated by time, use a fixed slot duration. Free slots are bookable time chunks.
  // Use a default of 30 min per slot — GHL free slots represent one bookable slot each.
  // To be more precise, look up the calendar that generated each slot.
  let freeSlotMinutes = 0;
  for (const [slotTime, calId] of allFreeSlots.entries()) {
    freeSlotMinutes += calSlotDurations[calId] || 30;
  }

  // 3. Fetch calendar events (appointments, breaks, blocks)
  const events = await _fetchCalendarEvents(httpClient, locationId, barberGhlId, startMs, endMs);

  // 4. Calculate appointment minutes (exclude cancelled, exclude breaks/blocks)
  const { appointmentMinutes, appointmentCount, byDayOfWeek } = _processEvents(events, calendarIds);

  // 5. Compute
  const capacityMinutes = freeSlotMinutes + appointmentMinutes;
  const utilizedMinutes = appointmentMinutes;
  const utilization = capacityMinutes > 0
    ? round((utilizedMinutes / capacityMinutes) * 100, 1)
    : null;

  return {
    utilization,
    capacityMinutes,
    utilizedMinutes,
    freeSlotMinutes,
    appointmentCount,
    periodDays,
    mode: "live",
    // Legacy fields
    bookedHours: round(utilizedMinutes / 60, 1),
    availableHours: round(capacityMinutes / 60, 1),
    byDayOfWeek,
    scheduleSource: "free_slots",
  };
}

/**
 * MODE 2 — Historical: Supabase appointments + calendar openHours/schedule rules.
 * Reconstructs capacity from calendar configuration for past periods
 * where Free Slots API is unavailable.
 *
 * Uses a SINGLE HC (shortest-slot) calendar for the capacity grid to avoid
 * double-counting when multiple calendars (public + F&F) cover the same hours.
 * Multiple calendars represent different service types on the same chair, not
 * additional capacity.
 */
async function _historicalUtilization(ghlBarber, barberGhlId, locationId, calendarIds, startDate, endDateStr, periodDays) {
  const httpClient = ghlBarber.getHttpClient();

  // 1. Use the primary HC (haircut) calendar from kioskConfig for the capacity grid.
  //    This is the canonical base — all calendars share the same chair/working hours.
  const { BARBER_DATA } = require("../config/kioskConfig");
  const barberConfig = BARBER_DATA.find(b => b.ghlUserId === barberGhlId);
  const gridCalId = barberConfig?.calendars?.haircut || calendarIds[0];

  let gridConfig = null;
  try {
    const calResp = await ghlBarber.calendars.getCalendar({ calendarId: gridCalId });
    const cal = calResp?.calendar || calResp;
    const rawOpenHours = cal?.openHours;
    const openHours = Array.isArray(rawOpenHours) && rawOpenHours.length > 0 ? rawOpenHours : null;
    gridConfig = {
      openHours,
      slotDuration: cal?.slotDuration || 30,
      slotInterval: cal?.slotInterval || 30,
    };
  } catch (err) {
    console.warn(`[ChairUtil Historical] Grid calendar config failed for ${gridCalId}: ${err.message}`);
  }

  // 1b. Fetch schedule rules to get accurate working hours.
  //     ALWAYS prefer the "Work Hours" schedule (calendarIds: []) — it represents actual
  //     working hours and is narrower than individual calendar schedules which may have
  //     wider booking windows. Fall back to a calendar-linked schedule only if no
  //     Work Hours schedule exists.
  try {
    const schedResp = await httpClient.get(
      `/calendars/schedules/search?locationId=${locationId}&userId=${barberGhlId}`
    );
    const schedules = schedResp.data?.schedules || [];

    // Prefer "Work Hours" schedule (not linked to any calendar, represents actual chair time)
    let gridSchedule = schedules.find(s =>
      (s.calendarIds || []).length === 0 && (s.rules || []).some(r => r.type === "wday" && r.intervals?.length > 0)
    );

    // Fall back to schedule linked to the grid calendar
    if (!gridSchedule) {
      gridSchedule = schedules.find(s => (s.calendarIds || []).includes(gridCalId));
    }

    if (gridSchedule) {
      const dayNameToNum = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const openHours = [];
      for (const rule of (gridSchedule.rules || [])) {
        if (rule.type !== "wday") continue;
        const dayNum = dayNameToNum[rule.day];
        if (dayNum == null) continue;
        const intervals = (rule.intervals || []).filter(iv => iv.from && iv.to);
        if (intervals.length === 0) continue;
        const hours = intervals.map(iv => {
          const [fh, fm] = iv.from.split(":").map(Number);
          const [th, tm] = iv.to.split(":").map(Number);
          return { openHour: fh, openMinute: fm, closeHour: th, closeMinute: tm };
        });
        openHours.push({ daysOfTheWeek: [dayNum], hours });
      }
      if (openHours.length > 0) {
        gridConfig.openHours = openHours;
        console.log(`[ChairUtil Historical] Using schedule "${gridSchedule.name || 'unnamed'}" for capacity grid (${openHours.length} days)`);
      }
    }
  } catch (err) {
    console.warn(`[ChairUtil Historical] Schedule rules fetch failed: ${err.message}`);
  }

  // 2. Fetch appointments from Supabase (authoritative for past data, avoids
  //    Calendar Events API double-counting issues with future/unsynced events)
  const { data: appointments, error: apptError } = await supabase
    .from("appointments")
    .select("start_time, end_time, status")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", ALL_BOOKED_STATUSES)
    .gte("start_time", new Date(startDate + "T00:00:00Z").toISOString())
    .lte("start_time", new Date(endDateStr + "T23:59:59Z").toISOString())
    .order("start_time", { ascending: true });

  if (apptError) {
    console.warn(`[ChairUtil Historical] Appointment query failed: ${apptError.message}`);
  }

  // 3. Calculate appointment minutes from Supabase data
  const { appointmentMinutes, appointmentCount, byDayOfWeek } = _processSupabaseAppointments(appointments || []);

  // 4. Generate slot grid from the single HC calendar for each day in the period
  let totalGridMinutes = 0;

  if (gridConfig?.openHours) {
    const current = new Date(startDate + "T12:00:00Z");
    const end = new Date(endDateStr + "T12:00:00Z");
    const slotDuration = gridConfig.slotDuration || 30;
    const slotInterval = gridConfig.slotInterval || 30;

    while (current <= end) {
      const dayNum = current.getUTCDay(); // 0=Sun, 1=Mon, ...

      const matchingRule = gridConfig.openHours.find(oh =>
        (oh.daysOfTheWeek || []).includes(dayNum)
      );

      if (matchingRule) {
        let daySlots = 0;
        for (const h of matchingRule.hours || []) {
          const fromMin = (h.openHour || 0) * 60 + (h.openMinute || 0);
          const toMin = (h.closeHour || 0) * 60 + (h.closeMinute || 0);
          for (let m = fromMin; m + slotDuration <= toMin; m += slotInterval) {
            daySlots++;
          }
        }
        totalGridMinutes += daySlots * slotDuration;
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }
  }

  // 5. Capacity = grid - displaced + appointments
  //    But more simply: capacity = freeSlotMinutes + appointmentMinutes
  //    where freeSlotMinutes = totalGridMinutes - appointmentMinutes (appointments displace grid slots)
  //    So: capacity = totalGridMinutes (the grid is the total capacity envelope)
  //    Actually: the grid represents TOTAL theoretical capacity.
  //    Displaced slots = grid slots overlapped by appointments.
  //    free = grid - displaced appointments
  //    capacity = free + actual appointment minutes = grid - displaced + appointment minutes
  //    For simplicity and accuracy: capacity = totalGridMinutes when grid slots match appointment duration.
  //    When H+B displaces more grid slots than its actual duration, capacity is slightly less.
  //    For historical mode, use: capacity = totalGridMinutes, utilized = appointmentMinutes.
  //    This is slightly less precise than live mode but good enough for 8-week trend context.
  const capacityMinutes = totalGridMinutes;
  const utilizedMinutes = appointmentMinutes;
  const freeSlotMinutes = Math.max(0, capacityMinutes - utilizedMinutes);
  const utilization = capacityMinutes > 0
    ? round((utilizedMinutes / capacityMinutes) * 100, 1)
    : null;

  return {
    utilization,
    capacityMinutes,
    utilizedMinutes,
    freeSlotMinutes,
    appointmentCount,
    periodDays,
    mode: "historical",
    // Legacy fields
    bookedHours: round(utilizedMinutes / 60, 1),
    availableHours: round(capacityMinutes / 60, 1),
    byDayOfWeek,
    scheduleSource: "open_hours",
  };
}

/**
 * Fetch calendar events via raw HTTP with Version 2021-04-15.
 * SDK default version (2021-07-28) returns empty for this endpoint.
 */
async function _fetchCalendarEvents(httpClient, locationId, userId, startMs, endMs) {
  try {
    const resp = await httpClient.get(
      `/calendars/events?locationId=${locationId}&startTime=${startMs}&endTime=${endMs}&userId=${userId}`,
      { headers: { Version: "2021-04-15" } }
    );
    return resp.data?.events || [];
  } catch (err) {
    console.warn(`[ChairUtil] Calendar events fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Process calendar events: calculate appointment minutes and per-day breakdown.
 * Excludes cancelled appointments and non-appointment events (breaks, blocks).
 * If calendarIds is provided, only counts appointments on those calendars.
 */
function _processEvents(events, calendarIds = null) {
  const calFilter = calendarIds ? new Set(calendarIds) : null;
  let appointmentMinutes = 0;
  let appointmentCount = 0;
  const byDay = {};
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const breakKeywords = ["break", "lunch", "block", "time off", "blocked", "unavailable"];

  for (const ev of events) {
    // Skip non-appointment events (breaks, blocks)
    const title = (ev.title || "").toLowerCase();
    if (breakKeywords.some(kw => title.includes(kw))) continue;

    // Must be an appointment (has contactId) and not cancelled
    if (!ev.contactId) continue;
    const status = (ev.appointmentStatus || "").toLowerCase();
    if (status === "cancelled") continue;

    // Skip appointments on calendars not in our tracking set
    if (calFilter && ev.calendarId && !calFilter.has(ev.calendarId)) continue;

    const start = new Date(ev.startTime);
    const end = new Date(ev.endTime);
    const durationMinutes = (end - start) / (1000 * 60);

    if (durationMinutes > 0 && durationMinutes < 480) {
      appointmentMinutes += durationMinutes;
      appointmentCount++;

      // Central time day-of-week for byDayOfWeek
      const centralDate = new Date(start.toLocaleString("en-US", { timeZone: "America/Chicago" }));
      const dayName = dayNames[centralDate.getDay()];
      const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(start);
      if (!byDay[dayName]) byDay[dayName] = { bookedMinutes: 0, workedDates: new Set() };
      byDay[dayName].bookedMinutes += durationMinutes;
      byDay[dayName].workedDates.add(dateKey);
    }
  }

  const byDayOfWeek = {};
  for (const [dayName, data] of Object.entries(byDay)) {
    const dayCount = data.workedDates.size;
    byDayOfWeek[dayName] = {
      avgBookedHours: dayCount > 0 ? round(data.bookedMinutes / dayCount / 60, 1) : 0,
      daysWorked: dayCount,
    };
  }

  return { appointmentMinutes, appointmentCount, byDayOfWeek };
}

/**
 * Process Supabase appointment rows for historical utilization.
 * Similar to _processEvents but works with Supabase appointment format.
 */
function _processSupabaseAppointments(appointments) {
  let appointmentMinutes = 0;
  let appointmentCount = 0;
  const byDay = {};
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  for (const appt of appointments) {
    if (appt.status === "cancelled") continue;

    const start = new Date(appt.start_time);
    const end = new Date(appt.end_time);
    const durationMinutes = (end - start) / (1000 * 60);

    if (durationMinutes > 0 && durationMinutes < 480) {
      appointmentMinutes += durationMinutes;
      appointmentCount++;

      const centralDate = new Date(start.toLocaleString("en-US", { timeZone: "America/Chicago" }));
      const dayName = dayNames[centralDate.getDay()];
      const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(start);
      if (!byDay[dayName]) byDay[dayName] = { bookedMinutes: 0, workedDates: new Set() };
      byDay[dayName].bookedMinutes += durationMinutes;
      byDay[dayName].workedDates.add(dateKey);
    }
  }

  const byDayOfWeek = {};
  for (const [dayName, data] of Object.entries(byDay)) {
    const dayCount = data.workedDates.size;
    byDayOfWeek[dayName] = {
      avgBookedHours: dayCount > 0 ? round(data.bookedMinutes / dayCount / 60, 1) : 0,
      daysWorked: dayCount,
    };
  }

  return { appointmentMinutes, appointmentCount, byDayOfWeek };
}


/**
 * 2.4 Visit Frequency Distribution
 *
 * Histogram of average days between visits for clients with 2+ visits.
 * Buckets: <14 days, 14-21, 22-35, 36-60, 60+
 *
 * Returns: { buckets: [{ label, range, count, percentage }], totalClients, avgFrequency }
 */
async function getVisitFrequencyDistribution(barberGhlId, locationId) {
  const { data: appointments, error } = await fetchAllRows(supabase
    .from("appointments")
    .select("contact_id, start_time")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true }));

  if (error) throw new Error(`Visit frequency query failed: ${error.message}`);
  if (!appointments || appointments.length === 0) {
    return { buckets: buildEmptyBuckets(), totalClients: 0, avgFrequency: null };
  }

  // Group by contact
  const byContact = {};
  for (const appt of appointments) {
    if (!byContact[appt.contact_id]) byContact[appt.contact_id] = [];
    byContact[appt.contact_id].push(new Date(appt.start_time));
  }

  // For contacts with 2+ visits, compute average gap
  const avgGaps = [];
  for (const contactId of Object.keys(byContact)) {
    const visits = byContact[contactId];
    if (visits.length < 2) continue;

    let totalGap = 0;
    for (let i = 1; i < visits.length; i++) {
      totalGap += daysBetween(visits[i - 1], visits[i]);
    }
    const avgGap = totalGap / (visits.length - 1);
    avgGaps.push(avgGap);
  }

  if (avgGaps.length === 0) {
    return { buckets: buildEmptyBuckets(), totalClients: 0, avgFrequency: null };
  }

  // Bucket definitions — ranges are [inclusive, exclusive)
  const bucketDefs = [
    { label: "< 14 days", range: [0, 14], count: 0 },
    { label: "14–21 days", range: [14, 22], count: 0 },
    { label: "22–35 days", range: [22, 36], count: 0 },
    { label: "36–60 days", range: [36, 61], count: 0 },
    { label: "60+ days", range: [61, Infinity], count: 0 },
  ];

  for (const gap of avgGaps) {
    for (const bucket of bucketDefs) {
      if (gap >= bucket.range[0] && gap < bucket.range[1]) {
        bucket.count++;
        break;
      }
    }
  }

  const totalClients = avgGaps.length;
  const overallAvg = round(avgGaps.reduce((s, g) => s + g, 0) / totalClients, 1);

  const buckets = bucketDefs.map(b => ({
    label: b.label,
    count: b.count,
    percentage: round((b.count / totalClients) * 100, 1),
  }));

  return { buckets, totalClients, avgFrequency: overallAvg };
}

function buildEmptyBuckets() {
  return [
    { label: "< 14 days", count: 0, percentage: 0 },
    { label: "14–21 days", count: 0, percentage: 0 },
    { label: "22–35 days", count: 0, percentage: 0 },
    { label: "36–60 days", count: 0, percentage: 0 },
    { label: "60+ days", count: 0, percentage: 0 },
  ];
}

/**
 * Fetch all Tier 2 diagnostic metrics in one call.
 */
async function getDiagnostics(barberGhlId, locationId, periodDays = 30) {
  const [
    attrition,
    newClientTrend,
    chairUtilization,
    visitFrequency,
  ] = await Promise.all([
    getAttritionRate(barberGhlId, locationId),
    getNewClientTrend(barberGhlId, locationId),
    getChairUtilization(barberGhlId, locationId, periodDays),
    getVisitFrequencyDistribution(barberGhlId, locationId),
  ]);

  return {
    attritionRate: attrition,
    newClientTrend,
    chairUtilization,
    visitFrequencyDistribution: visitFrequency,
  };
}

/**
 * Fetch all Tier 1 metrics in one call.
 * Returns the complete health check data plus previous-period values for trend arrows.
 *
 * For flex metrics (revenue, tip, no-show, cancellation), computes the equivalent
 * prior period (e.g., 30d current → previous 30d window before that).
 * For fixed metrics (rebooking, active clients, regulars), trend arrows come from
 * the monthly trends table (Phase 3) — not computed here.
 */
async function getHealthCheck(barberGhlId, locationId, periodDays = 30) {
  // Compute previous period date range for trend comparison
  const prevRange = getPreviousPeriodRange(periodDays);

  const [
    rebooking,
    activeClients,
    regulars,
    avgRevenue,
    avgTip,
    noShow,
    cancellation,
    // Previous period — flex metrics only (rate-only, no repeat offenders needed)
    prevAvgRevenue,
    prevAvgTip,
    prevNoShow,
    prevCancellation,
  ] = await Promise.all([
    getRebookingRate(barberGhlId, locationId),
    getActiveClientCount(barberGhlId, locationId),
    getRegularsCount(barberGhlId, locationId),
    getAvgRevenuePerVisit(barberGhlId, locationId, periodDays),
    getAvgTipPercentage(barberGhlId, locationId, periodDays),
    getNoShowRate(barberGhlId, locationId, periodDays),
    getCancellationRate(barberGhlId, locationId, periodDays),
    // Previous period queries — use startDateOverride + endDate for exact prior window
    getAvgRevenuePerVisit(barberGhlId, locationId, periodDays, prevRange.endDate, prevRange.startDate),
    getAvgTipPercentage(barberGhlId, locationId, periodDays, prevRange.endDate, prevRange.startDate),
    getNoShowRate(barberGhlId, locationId, periodDays, prevRange.endDate, prevRange.startDate),
    getCancellationRate(barberGhlId, locationId, periodDays, prevRange.endDate, prevRange.startDate),
  ]);

  return {
    rebookingRate: rebooking,
    activeClients,
    regulars,
    avgRevenuePerVisit: avgRevenue,
    avgTipPercentage: avgTip,
    noShowRate: noShow,
    cancellationRate: cancellation,
    // Previous period values for trend arrow computation on iOS
    previousPeriod: {
      avgRevenuePerVisit: prevAvgRevenue.avgRevenue,
      avgServiceRevenue: prevAvgRevenue.avgServiceRevenue,
      avgTipPercentage: prevAvgTip.avgTipPercentage,
      noShowRate: prevNoShow.rate,
      cancellationRate: prevCancellation.rate,
    },
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
function getStartDate(periodDays, asOfDate = null) {
  const ref = asOfDate ? new Date(asOfDate + "T12:00:00Z") : new Date();
  if (periodDays === "ytd") {
    return `${ref.getFullYear()}-01-01`;
  }

  const d = new Date(ref);
  d.setDate(d.getDate() - periodDays);
  return d.toISOString().split("T")[0];
}

/**
 * Get the previous period's equivalent periodDays for trend comparison.
 * For numeric periods: returns 2x the period (e.g., 30d current → 30-60d prior).
 * For YTD: returns the same number of days into the prior year.
 *
 * Returns { prevPeriodDays, prevEndDate } where prevEndDate caps queries
 * to only the previous window (not overlapping with current).
 */
function getPreviousPeriodRange(periodDays, asOfDate = null) {
  const now = asOfDate ? new Date(asOfDate + "T12:00:00Z") : new Date();
  if (periodDays === "ytd") {
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + 1;
    return {
      startDate: `${now.getFullYear() - 1}-01-01`,
      endDate: new Date(now.getFullYear() - 1, 0, dayOfYear).toISOString().split("T")[0],
    };
  }
  const end = new Date(now);
  end.setDate(end.getDate() - periodDays);
  const start = new Date(end);
  start.setDate(start.getDate() - periodDays);
  return {
    startDate: start.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
  };
}

/**
 * Extract a contact name from the appointment title (fallback only).
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
 * Batch-lookup contact names from client_financials table.
 * Returns a Map<contactId, contactName>.
 * Falls back to extractContactName(title) if not found in client_financials.
 */
async function getContactNames(contactIds) {
  const nameMap = new Map();
  if (!contactIds || contactIds.length === 0) return nameMap;

  const uniqueIds = [...new Set(contactIds)];

  const { data, error } = await supabase
    .from("client_financials")
    .select("contact_id, contact_name")
    .in("contact_id", uniqueIds);

  if (!error && data) {
    for (const row of data) {
      if (row.contact_name) {
        nameMap.set(row.contact_id, row.contact_name);
      }
    }
  }

  return nameMap;
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

// ──────────────────────────────────────
// Tier 3: Revenue Projection + Cohort Analysis
// ──────────────────────────────────────

/**
 * 3.1 Revenue Projection
 *
 * Projects monthly income based on:
 *   regulars_count × (30 / avg_visit_frequency_days) × avg_revenue_per_visit
 *
 * Also computes a "what-if" scenario: if rebooking rate increased by 10%,
 * how many more regulars would that yield, and what would projected revenue be?
 *
 * Returns: {
 *   projectedMonthlyRevenue,
 *   assumptions: { regularsCount, avgFrequencyDays, visitsPerMonth, avgRevenuePerVisit },
 *   whatIf: { rebookingIncrease, additionalRegulars, projectedRevenue }
 * }
 */
async function getRevenueProjection(barberGhlId, locationId) {
  // Gather the three inputs in parallel
  const [regulars, frequency, revenue, rebooking] = await Promise.all([
    getRegularsCount(barberGhlId, locationId),
    getVisitFrequencyDistribution(barberGhlId, locationId),
    getAvgRevenuePerVisit(barberGhlId, locationId, 90), // 90-day window for stable average
    getRebookingRate(barberGhlId, locationId),
  ]);

  const regularsCount = regulars.count || 0;
  const avgFrequencyDays = frequency.avgFrequency || null;
  const avgRevenue = revenue.avgRevenue || 0;

  // Can't project without all three factors
  if (regularsCount === 0 || !avgFrequencyDays || avgRevenue === 0) {
    return {
      projectedMonthlyRevenue: null,
      assumptions: {
        regularsCount,
        avgFrequencyDays,
        visitsPerMonth: null,
        avgRevenuePerVisit: avgRevenue,
      },
      whatIf: null,
      insufficientData: true,
    };
  }

  const visitsPerMonth = round(30 / avgFrequencyDays, 2);
  const projectedMonthlyRevenue = round(regularsCount * visitsPerMonth * avgRevenue, 2);

  // What-if: +10% rebooking rate → estimate additional regulars
  let whatIf = null;
  const currentRebookingForgiving = rebooking.forgiving;
  if (currentRebookingForgiving !== null && currentRebookingForgiving < 100) {
    // Total unique clients the barber has seen
    const totalClients = rebooking.total || 0;
    if (totalClients > 0) {
      // Current regulars come from current rebooking behavior
      // If rebooking forgiving goes up 10 percentage points, estimate how many more
      // clients would stick around to become regulars
      const boostedRate = Math.min(currentRebookingForgiving + 10, 100);
      const boostFactor = boostedRate / Math.max(currentRebookingForgiving, 1);
      const estimatedNewRegulars = Math.round(regularsCount * boostFactor);
      const additionalRegulars = estimatedNewRegulars - regularsCount;
      const boostedRevenue = round(estimatedNewRegulars * visitsPerMonth * avgRevenue, 2);

      whatIf = {
        currentRebookingRate: round(currentRebookingForgiving, 1),
        boostedRebookingRate: round(boostedRate, 1),
        rebookingIncreasePct: 10,
        currentRegulars: regularsCount,
        estimatedRegulars: estimatedNewRegulars,
        additionalRegulars,
        projectedRevenue: boostedRevenue,
        additionalRevenue: round(boostedRevenue - projectedMonthlyRevenue, 2),
      };
    }
  }

  return {
    projectedMonthlyRevenue,
    assumptions: {
      regularsCount,
      avgFrequencyDays: round(avgFrequencyDays, 1),
      visitsPerMonth,
      avgRevenuePerVisit: avgRevenue,
    },
    whatIf,
    insufficientData: false,
  };
}

/**
 * 3.2 Client Cohort Analysis
 *
 * Groups clients by the month of their first visit with this barber.
 * Tracks each cohort's retention over subsequent months.
 *
 * "Active in month N" = client had at least one completed appointment
 * in the calendar month that is N months after their cohort month.
 *
 * Returns: {
 *   cohorts: [
 *     {
 *       cohortMonth: "2025-10",
 *       cohortSize: 12,
 *       retention: [
 *         { monthsAfter: 0, activeCount: 12, retentionPct: 100 },
 *         { monthsAfter: 1, activeCount: 8, retentionPct: 66.7 },
 *         ...
 *       ]
 *     },
 *     ...
 *   ],
 *   maxMonthsTracked: 6,
 *   trend: "improving" | "declining" | "stable" | "insufficient_data"
 * }
 */
async function getCohortAnalysis(barberGhlId, locationId) {
  const { data: appointments, error } = await fetchAllRows(supabase
    .from("appointments")
    .select("contact_id, start_time")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true }));

  if (error) throw new Error(`Cohort analysis query failed: ${error.message}`);
  if (!appointments || appointments.length === 0) {
    return { cohorts: [], maxMonthsTracked: 0, trend: "insufficient_data" };
  }

  // Group appointments by contact, tracking visit months
  const contactVisits = {}; // contactId → Set of "YYYY-MM" strings
  const contactFirstMonth = {}; // contactId → "YYYY-MM"

  for (const appt of appointments) {
    const month = appt.start_time.substring(0, 7); // "YYYY-MM"
    if (!contactVisits[appt.contact_id]) {
      contactVisits[appt.contact_id] = new Set();
      contactFirstMonth[appt.contact_id] = month;
    }
    contactVisits[appt.contact_id].add(month);
  }

  // Group contacts by their first-visit month (cohort)
  const cohortMembers = {}; // "YYYY-MM" → [contactId, ...]
  for (const [contactId, firstMonth] of Object.entries(contactFirstMonth)) {
    if (!cohortMembers[firstMonth]) cohortMembers[firstMonth] = [];
    cohortMembers[firstMonth].push(contactId);
  }

  // Current month for computing how far we can track
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Sort cohort months chronologically
  const cohortMonths = Object.keys(cohortMembers).sort();

  // Only include cohorts with at least 3 clients (meaningful retention data)
  // and limit to last 12 months of cohorts
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const cutoffMonth = `${twelveMonthsAgo.getFullYear()}-${String(twelveMonthsAgo.getMonth() + 1).padStart(2, "0")}`;

  const cohorts = [];
  let maxMonthsTracked = 0;

  for (const cohortMonth of cohortMonths) {
    if (cohortMonth < cutoffMonth) continue;
    if (cohortMonth > currentMonth) continue;

    const members = cohortMembers[cohortMonth];
    if (members.length < 3) continue;

    const cohortSize = members.length;
    const monthsElapsed = monthDiff(cohortMonth, currentMonth);
    const trackMonths = Math.min(monthsElapsed, 6); // Cap at 6 months of tracking

    if (trackMonths > maxMonthsTracked) maxMonthsTracked = trackMonths;

    const retention = [];
    for (let m = 0; m <= trackMonths; m++) {
      const targetMonth = addMonths(cohortMonth, m);
      let activeCount = 0;

      for (const contactId of members) {
        if (contactVisits[contactId].has(targetMonth)) {
          activeCount++;
        }
      }

      retention.push({
        monthsAfter: m,
        activeCount,
        retentionPct: round((activeCount / cohortSize) * 100, 1),
      });
    }

    cohorts.push({
      cohortMonth,
      cohortLabel: formatCohortLabel(cohortMonth),
      cohortSize,
      retention,
    });
  }

  // Determine trend: compare M1 retention of recent cohorts vs older ones
  const trend = computeCohortTrend(cohorts);

  return { cohorts, maxMonthsTracked, trend };
}

/**
 * Helper: compute month difference between two "YYYY-MM" strings.
 */
function monthDiff(fromMonth, toMonth) {
  const [fromY, fromM] = fromMonth.split("-").map(Number);
  const [toY, toM] = toMonth.split("-").map(Number);
  return (toY - fromY) * 12 + (toM - fromM);
}

/**
 * Helper: add N months to a "YYYY-MM" string, returns "YYYY-MM".
 */
function addMonths(monthStr, n) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Helper: format "YYYY-MM" → "Oct 2025"
 */
function formatCohortLabel(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${y}`;
}

/**
 * Helper: determine if cohort retention is improving, declining, or stable.
 * Compares M1 retention of the 3 most recent cohorts vs the 3 before that.
 */
function computeCohortTrend(cohorts) {
  // Need at least 4 cohorts with M1 data to determine a trend
  const withM1 = cohorts.filter(c => c.retention.length >= 2);
  if (withM1.length < 4) return "insufficient_data";

  const recent = withM1.slice(-3);
  const older = withM1.slice(-6, -3);

  if (older.length < 3) return "insufficient_data";

  const recentAvgM1 = recent.reduce((s, c) => s + c.retention[1].retentionPct, 0) / recent.length;
  const olderAvgM1 = older.reduce((s, c) => s + c.retention[1].retentionPct, 0) / older.length;

  const diff = recentAvgM1 - olderAvgM1;
  if (diff > 5) return "improving";
  if (diff < -5) return "declining";
  return "stable";
}

module.exports = {
  // Tier 1
  getRebookingRate,
  getActiveClientCount,
  getRegularsCount,
  getAvgRevenuePerVisit,
  getAvgTipPercentage,
  getNoShowRate,
  getCancellationRate,
  getHealthCheck,
  // Tier 2
  getAttritionRate,
  getNewClientTrend,
  getChairUtilization,
  getVisitFrequencyDistribution,
  getDiagnostics,
  parsePeriod,
  // Tier 3
  getRevenueProjection,
  getCohortAnalysis,
  // Exported for testing / cron
  getServiceTypeMap,
  getContactNames,
  getPreviousPeriodRange,
  EVALUATION_WINDOWS,
  DEFAULT_EVAL_WINDOW,
  COMPLETED_STATUSES,
  ALL_BOOKED_STATUSES,
};
