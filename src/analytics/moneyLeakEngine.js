// moneyLeakEngine.js
// Money Leak Scorecard computation engine.
// Computes the full scorecard: money on the floor, rebook attempt rate,
// weekly goal vs pace, and focus metrics.

const { supabase, fetchAllRows } = require("../clients/supabaseClient");
const {
  getRebookingRate,
  getActiveClientCount,
  getAvgRevenuePerVisit,
  getAvgTipPercentage,
  getVisitFrequencyDistribution,
  getChairUtilization,
} = require("./analyticsQueries");
const { getServicePriceMap } = require("../config/barberServicePrices");
const { BARBER_LOCATION_ID } = require("../config/kioskConfig");

// Completed appointment statuses (mirrored from analyticsQueries)
const COMPLETED_STATUSES = ["showed", "confirmed"];

/**
 * Capacity zones — the job of the scorecard changes based on utilization.
 *
 *   BUILD  (< 70%):    "Fill your chair." Aggressive rebook goals.
 *   OPTIMIZE (70-89%): "Tighten rebooking." Moderate sliding goals.
 *   CAP (≥ 90%):       "You're full." Stop nagging about volume;
 *                       goal = their own trailing rate or a low floor.
 */
const CAPACITY_ZONES = {
  BUILD:    { name: "build",    threshold: 70,  relevance: 1.0, message: "You're leaving serious money on the floor. Fill your chair." },
  OPTIMIZE: { name: "optimize", threshold: 90,  relevance: 0.6, message: "Tighten rebooking on the right clients. You're building a strong book." },
  CAP:      { name: "cap",      threshold: 100, relevance: 0.0, message: "You're in the Full Book Zone. Focus on pricing & client mix." },
};

/**
 * Determine which capacity zone a barber falls into.
 */
function getCapacityZone(utilizationPct) {
  if (utilizationPct == null) return CAPACITY_ZONES.OPTIMIZE; // safe default
  if (utilizationPct < 70) return CAPACITY_ZONES.BUILD;
  if (utilizationPct < 90) return CAPACITY_ZONES.OPTIMIZE;
  return CAPACITY_ZONES.CAP;
}

/**
 * Dynamic goal rebook rate based on capacity zone.
 *
 *   BUILD  (< 70%):  60% flat — aggressive, fill the chair.
 *   OPTIMIZE (70-89%): sliding 45% → 15%.
 *   CAP (≥ 90%):     use the barber's own trailing rate (or 10% floor).
 *                     This makes conversionGap = 0 for anyone already
 *                     meeting the low bar, so moneyOnTheFloor = $0.
 */
function getGoalRebookRate(utilizationPct, currentRebookRate) {
  if (utilizationPct == null) return 45; // safe default

  // BUILD zone: aggressive flat goal
  if (utilizationPct < 70) return 60;

  // OPTIMIZE zone: sliding scale 45% → 15%
  if (utilizationPct < 90) {
    // 70% util → 45% goal, 90% util → 15% goal (linear)
    return 45 - (utilizationPct - 70) * 1.5; // 45 → 15
  }

  // CAP zone: goal = their own trailing rate or 10% floor, whichever is lower.
  // If they're already at or above 10%, gap = 0, money on floor = $0.
  if (currentRebookRate != null) {
    return Math.min(currentRebookRate, 10);
  }
  return 10;
}

/**
 * Compute the rebook attempt rate: "Booked next visit before leaving."
 *
 * For each completed appointment in the period, checks if a future appointment
 * was created for the same contact_id on the same calendar day as the appointment.
 *
 * Also produces the 2x2 breakdown:
 *   - bookedAndReturned: booked next visit AND client has a subsequent completed visit
 *   - bookedAndDidNotReturn: booked but no subsequent completed visit
 *   - didNotBookAndReturned: didn't book but returned anyway
 *   - didNotBookAndLost: didn't book and didn't return (THE LEAK)
 */
async function computeRebookAttemptRate(barberGhlId, locationId, periodDays = 90) {
  const ATTRIBUTION_DAYS = 1; // next appointment must be CREATED within 1 day of the visit

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - periodDays);
  const startDateStr = startDate.toISOString().split("T")[0];

  // Get all completed appointments for this barber (need full history for "returned" check)
  const { data: allAppointments, error } = await fetchAllRows(supabase
    .from("appointments")
    .select("id, contact_id, start_time, status, created_at, ghl_created_at")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .order("start_time", { ascending: true }));

  if (error) throw new Error(`Rebook attempt query failed: ${error.message}`);
  if (!allAppointments || allAppointments.length === 0) {
    return {
      attemptRate: null, totalCompleted: 0,
      bookedNextVisit: 0, didNotBook: 0,
      bookedAndReturned: 0, bookedAndDidNotReturn: 0,
      didNotBookAndReturned: 0, didNotBookAndLost: 0,
    };
  }

  // Also get ALL appointments (including future/pending) to check for bookings
  const { data: allBookings, error: bookErr } = await fetchAllRows(supabase
    .from("appointments")
    .select("id, contact_id, start_time, created_at, ghl_created_at")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .order("start_time", { ascending: true }));

  if (bookErr) throw new Error(`Rebook bookings query failed: ${bookErr.message}`);

  // Index bookings by contact_id for fast lookup
  const bookingsByContact = {};
  for (const b of (allBookings || [])) {
    if (!bookingsByContact[b.contact_id]) bookingsByContact[b.contact_id] = [];
    bookingsByContact[b.contact_id].push(b);
  }

  // Filter to period appointments
  const periodAppointments = allAppointments.filter(
    a => a.start_time >= startDateStr + "T00:00:00Z"
  );

  let bookedNextVisit = 0;
  let didNotBook = 0;
  let bookedAndReturned = 0;
  let bookedAndDidNotReturn = 0;
  let didNotBookAndReturned = 0;
  let didNotBookAndLost = 0;

  for (const appt of periodAppointments) {
    if (!appt.start_time || !appt.contact_id) continue;
    const apptTime = new Date(appt.start_time).getTime();
    const attributionWindow = ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000; // ms
    const contactBookings = bookingsByContact[appt.contact_id] || [];

    // Check if a future appointment was CREATED within the attribution window
    // after this visit. "Created" = when the booking was made, not when the
    // appointment is scheduled for.
    const bookedWithinWindow = contactBookings.some(b => {
      if (b.start_time <= appt.start_time) return false; // must be a future appointment
      const creationDate = b.created_at || b.ghl_created_at;
      if (!creationDate) return false;
      const createdTime = new Date(creationDate).getTime();
      return createdTime >= apptTime && createdTime <= apptTime + attributionWindow;
    });

    // Check if the client has any subsequent COMPLETED appointment
    const hasReturned = allAppointments.some(
      a => a.contact_id === appt.contact_id && a.start_time > appt.start_time
    );

    if (bookedWithinWindow) {
      bookedNextVisit++;
      if (hasReturned) {
        bookedAndReturned++;
      } else {
        bookedAndDidNotReturn++;
      }
    } else {
      didNotBook++;
      if (hasReturned) {
        didNotBookAndReturned++;
      } else {
        didNotBookAndLost++;
      }
    }
  }

  const totalCompleted = periodAppointments.length;
  const attemptRate = totalCompleted > 0
    ? Math.round((bookedNextVisit / totalCompleted) * 1000) / 10
    : null;

  return {
    attemptRate,
    totalCompleted,
    bookedNextVisit,
    didNotBook,
    bookedAndReturned,
    bookedAndDidNotReturn,
    didNotBookAndReturned,
    didNotBookAndLost,
  };
}

/**
 * Compute the "money on the floor" — dollar amount left on the table.
 *
 * Formula:
 *   Lost regulars = New clients this month × (Goal rebook% − Current rebook%)
 *   Money on floor = Lost regulars × 12-month value per regular
 *   12-month value = Avg revenue/visit × (365 ÷ Avg days between visits)
 */
async function computeMoneyOnTheFloor(barberGhlId, locationId) {
  const [rebooking, activeClients, avgRevenue, frequency, chairUtil] = await Promise.all([
    getRebookingRate(barberGhlId, locationId),
    getActiveClientCount(barberGhlId, locationId),
    getAvgRevenuePerVisit(barberGhlId, locationId, 90),
    getVisitFrequencyDistribution(barberGhlId, locationId),
    getChairUtilization(barberGhlId, locationId, 30),
  ]);

  const recentNewClients = activeClients.newClients || 0;
  const currentRebookRate = rebooking.strict; // strict = default (includes pending)
  const chairUtilization = chairUtil.utilization;
  const zone = getCapacityZone(chairUtilization);
  const goalRebookRate = getGoalRebookRate(chairUtilization, currentRebookRate);
  const avgRevenuePerVisit = avgRevenue.avgRevenue;
  const avgFrequencyDays = frequency.avgFrequency;

  // Availability-adjusted scoring (from break-aware capacity engine)
  const availabilityIndex = chairUtil.availabilityIndex ?? null;
  const shopImpact = chairUtil.shopImpact ?? null;
  const blockedPercent = chairUtil.blockedPercent ?? 0;
  const atRisk = chairUtil.atRisk ?? false;

  // Can't compute without these inputs
  if (currentRebookRate == null || avgRevenuePerVisit == null || avgFrequencyDays == null || avgFrequencyDays === 0) {
    return {
      totalAmount: null,
      lostRegulars: null,
      annualValuePerRegular: null,
      nonRegularCount: rebooking.nonRegularCount || 0,
      recentNewClients,
      currentRebookRate,
      goalRebookRate: Math.round(goalRebookRate * 10) / 10,
      conversionGap: null,
      avgRevenuePerVisit,
      avgFrequencyDays,
      visitsPerYear: null,
      chairUtilization,
      availabilityIndex,
      shopImpact,
      blockedPercent,
      atRisk,
      capacityZone: zone.name,
      zoneMessage: zone.message,
      zoneRelevance: zone.relevance,
      insufficientData: true,
    };
  }

  const conversionGap = Math.max(0, goalRebookRate - currentRebookRate);
  const lostRegulars = Math.round(recentNewClients * (conversionGap / 100));
  const visitsPerYear = Math.round((365 / avgFrequencyDays) * 10) / 10;
  const annualValuePerRegular = Math.round(avgRevenuePerVisit * visitsPerYear * 100) / 100;
  const totalAmount = Math.round(lostRegulars * annualValuePerRegular * 100) / 100;

  return {
    totalAmount,
    lostRegulars,
    annualValuePerRegular,
    nonRegularCount: rebooking.nonRegularCount || 0,
    recentNewClients,
    currentRebookRate,
    goalRebookRate: Math.round(goalRebookRate * 10) / 10,
    conversionGap: Math.round(conversionGap * 10) / 10,
    avgRevenuePerVisit,
    avgFrequencyDays,
    visitsPerYear,
    chairUtilization,
    availabilityIndex,
    shopImpact,
    blockedPercent,
    atRisk,
    capacityZone: zone.name,
    zoneMessage: zone.message,
    zoneRelevance: zone.relevance,
    insufficientData: false,
  };
}

/**
 * Find the best revenue week for a barber.
 * Groups transactions by Mon-Sun week and returns the highest.
 */
async function findBestWeek(barberGhlId, locationId) {
  const { data: transactions, error } = await fetchAllRows(supabase
    .from("transactions")
    .select("gross_amount, session_date")
    .eq("artist_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .in("transaction_type", ["session_payment"])
    .order("session_date", { ascending: true }));

  if (error) throw new Error(`Best week query failed: ${error.message}`);
  if (!transactions || transactions.length === 0) {
    return { bestRevenue: null, bestWeekStart: null };
  }

  // Group by Mon-Sun week
  const weekRevenue = {};
  for (const t of transactions) {
    const date = new Date(t.session_date + "T12:00:00Z");
    // Get Monday of this week
    const day = date.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day; // Monday = 1
    const monday = new Date(date);
    monday.setUTCDate(monday.getUTCDate() + diff);
    const weekKey = monday.toISOString().split("T")[0];

    weekRevenue[weekKey] = (weekRevenue[weekKey] || 0) + parseFloat(t.gross_amount || 0);
  }

  let bestRevenue = 0;
  let bestWeekStart = null;
  for (const [weekStart, revenue] of Object.entries(weekRevenue)) {
    if (revenue > bestRevenue) {
      bestRevenue = revenue;
      bestWeekStart = weekStart;
    }
  }

  return {
    bestRevenue: Math.round(bestRevenue * 100) / 100,
    bestWeekStart,
  };
}

/**
 * Compute the weekly income goal: best week × 1.10
 */
async function computeWeeklyGoal(barberGhlId, locationId) {
  const best = await findBestWeek(barberGhlId, locationId);

  if (!best.bestRevenue) {
    return { goal: null, bestWeekRevenue: null, bestWeekDate: null };
  }

  return {
    goal: Math.round(best.bestRevenue * 1.10 * 100) / 100,
    bestWeekRevenue: best.bestRevenue,
    bestWeekDate: best.bestWeekStart,
  };
}

/**
 * Compute the current week's revenue pace.
 * Uses actual revenue earned so far PLUS projected revenue from upcoming
 * booked appointments (calendar price × (1 + avg tip %)).
 */
async function computeCurrentPace(barberGhlId, locationId) {
  // Get Monday and Sunday of the current week (Central time)
  const now = new Date();
  const centralDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(now); // "YYYY-MM-DD"

  const today = new Date(centralDateStr + "T12:00:00Z");
  const day = today.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() + diff);
  const mondayStr = monday.toISOString().split("T")[0];

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const sundayStr = sunday.toISOString().split("T")[0];

  // Days elapsed (1 = Monday, 7 = Sunday)
  const daysElapsed = day === 0 ? 7 : day;

  // 1. Actual revenue earned this week (transactions already recorded)
  const { data: transactions, error: txError } = await supabase
    .from("transactions")
    .select("gross_amount")
    .eq("artist_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .in("transaction_type", ["session_payment"])
    .gte("session_date", mondayStr)
    .lte("session_date", centralDateStr);

  if (txError) throw new Error(`Current pace query failed: ${txError.message}`);

  let currentWeekRevenue = 0;
  for (const t of (transactions || [])) {
    currentWeekRevenue += parseFloat(t.gross_amount || 0);
  }
  currentWeekRevenue = Math.round(currentWeekRevenue * 100) / 100;

  // 2. Upcoming booked appointments for the rest of this week
  //    (tomorrow through Sunday, or today if no transactions yet)
  const upcomingStartDate = centralDateStr; // include today's remaining appointments
  const { data: upcomingAppts, error: apptError } = await supabase
    .from("appointments")
    .select("calendar_id, start_time")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", ["confirmed", "booked"])
    .gt("start_time", centralDateStr + "T00:00:00Z")
    .lte("start_time", sundayStr + "T23:59:59Z");

  if (apptError) {
    console.warn(`[Pace] Upcoming appointments query failed: ${apptError.message}`);
  }

  // 3. Look up service prices per calendar
  const priceMap = await getServicePriceMap();

  let projectedFromBookings = 0;
  let bookedAppointmentCount = 0;
  const unmatchedCalendars = new Set();

  for (const appt of (upcomingAppts || [])) {
    const price = priceMap.get(appt.calendar_id);
    if (price != null) {
      projectedFromBookings += price;
      bookedAppointmentCount++;
    } else if (appt.calendar_id) {
      unmatchedCalendars.add(appt.calendar_id);
    }
  }

  if (unmatchedCalendars.size > 0) {
    console.warn(`[Pace] ${unmatchedCalendars.size} calendar(s) without prices: ${[...unmatchedCalendars].join(", ")}`);
  }

  // 4. Add avg tip % on top of projected service revenue
  let tipMultiplier = 1;
  try {
    const tipData = await getAvgTipPercentage(barberGhlId, locationId, 90);
    if (tipData.avgTipPercentage != null && tipData.avgTipPercentage > 0) {
      tipMultiplier = 1 + (tipData.avgTipPercentage / 100);
    }
  } catch (err) {
    console.warn(`[Pace] Tip percentage lookup failed: ${err.message}`);
  }

  projectedFromBookings = Math.round(projectedFromBookings * tipMultiplier * 100) / 100;

  // 5. Projected weekly total = actual earned + projected from remaining bookings
  const projectedRevenue = Math.round((currentWeekRevenue + projectedFromBookings) * 100) / 100;

  return {
    pace: projectedRevenue,
    currentWeekRevenue,
    projectedFromBookings,
    bookedAppointmentCount,
    tipMultiplier: Math.round(tipMultiplier * 1000) / 1000,
    daysElapsed,
  };
}

/**
 * Cap Zone metric: Average revenue per utilized hour (90-day window).
 * Shows whether a fully-booked barber is maximizing chair time.
 */
async function computeAvgRevenuePerHour(barberGhlId, locationId) {
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const startDateStr = startDate.toISOString().split("T")[0];

  // Total revenue from transactions
  const { data: transactions, error: txErr } = await fetchAllRows(supabase
    .from("transactions")
    .select("gross_amount")
    .eq("artist_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .in("transaction_type", ["session_payment"])
    .gte("session_date", startDateStr)
    .lte("session_date", endDate));

  if (txErr) throw new Error(`Cap zone revenue query failed: ${txErr.message}`);

  const totalRevenue = (transactions || []).reduce(
    (sum, t) => sum + parseFloat(t.gross_amount || 0), 0
  );

  // Total utilized hours from daily snapshots
  const { data: snapshots, error: snapErr } = await fetchAllRows(supabase
    .from("barber_analytics_snapshots")
    .select("utilized_minutes")
    .eq("barber_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .gte("snapshot_date", startDateStr)
    .lte("snapshot_date", endDate)
    .not("utilized_minutes", "is", null));

  if (snapErr) throw new Error(`Cap zone snapshot query failed: ${snapErr.message}`);

  const totalUtilizedMinutes = (snapshots || []).reduce(
    (sum, s) => sum + (s.utilized_minutes || 0), 0
  );

  if (totalUtilizedMinutes === 0 || totalRevenue === 0) return null;

  const totalUtilizedHours = totalUtilizedMinutes / 60;
  return Math.round((totalRevenue / totalUtilizedHours) * 100) / 100;
}

/**
 * Cap Zone metric: Overflow demand — signals that a barber is turning away business.
 *
 * Two proxies:
 *   1. fullyBookedDays: days in the last 30 where daily utilization = 100%
 *   2. avgWaitDays: average gap between appointment creation and start time
 *      for new clients (first visit with this barber) — longer waits = overflow
 */
async function computeOverflowDemand(barberGhlId, locationId) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const startStr = thirtyDaysAgo.toISOString().split("T")[0];
  const endStr = now.toISOString().split("T")[0];

  // 1. Fully booked days (utilization >= 100%)
  const { data: snapshots, error: snapErr } = await fetchAllRows(supabase
    .from("barber_analytics_snapshots")
    .select("utilization")
    .eq("barber_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .gte("snapshot_date", startStr)
    .lte("snapshot_date", endStr)
    .not("utilization", "is", null));

  if (snapErr) throw new Error(`Overflow demand snapshot query failed: ${snapErr.message}`);

  // utilization is stored as 0.0000-1.0000 in the snapshot table
  const fullyBookedDays = (snapshots || []).filter(s => s.utilization >= 1.0).length;

  // 2. Average wait days for new clients (90-day window for more data)
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const ninetyStr = ninetyDaysAgo.toISOString().split("T")[0];

  const { data: appointments, error: apptErr } = await fetchAllRows(supabase
    .from("appointments")
    .select("contact_id, start_time, created_at, ghl_created_at")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", locationId)
    .in("status", COMPLETED_STATUSES)
    .gte("start_time", ninetyStr + "T00:00:00Z")
    .order("start_time", { ascending: true }));

  if (apptErr) throw new Error(`Overflow demand appointments query failed: ${apptErr.message}`);

  // Find first-visit appointments (first time this contact appears)
  const seenContacts = new Set();
  const waitDays = [];
  for (const appt of (appointments || [])) {
    if (!appt.contact_id || seenContacts.has(appt.contact_id)) continue;
    seenContacts.add(appt.contact_id);

    const createdAt = appt.created_at || appt.ghl_created_at;
    if (!createdAt || !appt.start_time) continue;

    const created = new Date(createdAt).getTime();
    const start = new Date(appt.start_time).getTime();
    if (start <= created) continue; // skip if start is before creation (data issue)

    const days = (start - created) / (1000 * 60 * 60 * 24);
    if (days > 0 && days < 90) waitDays.push(days); // cap at 90 to filter outliers
  }

  const avgWaitDays = waitDays.length > 0
    ? Math.round((waitDays.reduce((a, b) => a + b, 0) / waitDays.length) * 10) / 10
    : null;

  return { fullyBookedDays, avgWaitDays };
}

/**
 * Cap Zone metric: Suggested price bump.
 * Only triggers when utilization > 90% for 4+ consecutive weeks.
 */
async function computeSuggestedPriceBump(barberGhlId, locationId, avgRevenuePerVisit) {
  if (avgRevenuePerVisit == null) return null;

  // Check the last 8 weeks of snapshots for consecutive >90% utilization
  const eightWeeksAgo = new Date();
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const startStr = eightWeeksAgo.toISOString().split("T")[0];

  const { data: snapshots, error } = await fetchAllRows(supabase
    .from("barber_analytics_snapshots")
    .select("snapshot_date, utilization")
    .eq("barber_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .gte("snapshot_date", startStr)
    .not("utilization", "is", null)
    .order("snapshot_date", { ascending: true }));

  if (error) throw new Error(`Price bump query failed: ${error.message}`);
  if (!snapshots || snapshots.length === 0) return null;

  // Group by Mon-Sun weeks, compute weekly avg utilization
  const weeklyUtils = {};
  for (const s of snapshots) {
    const date = new Date(s.snapshot_date + "T12:00:00Z");
    const day = date.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(date);
    monday.setUTCDate(monday.getUTCDate() + diff);
    const weekKey = monday.toISOString().split("T")[0];

    if (!weeklyUtils[weekKey]) weeklyUtils[weekKey] = [];
    weeklyUtils[weekKey].push(s.utilization); // 0.0-1.0 scale
  }

  // Check for 4+ consecutive weeks above 90%
  const weeks = Object.keys(weeklyUtils).sort();
  let consecutiveHigh = 0;
  let maxConsecutive = 0;
  for (const week of weeks) {
    const vals = weeklyUtils[week];
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (avg >= 0.90) {
      consecutiveHigh++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveHigh);
    } else {
      consecutiveHigh = 0;
    }
  }

  if (maxConsecutive < 4) return null;

  // Suggest ~10% bump, rounded to nearest $5
  const rawBump = avgRevenuePerVisit * 0.10;
  const amount = Math.max(5, Math.round(rawBump / 5) * 5);

  return {
    amount,
    consecutiveWeeksAbove90: maxConsecutive,
    message: `You've been 90%+ booked for ${maxConsecutive} weeks. You could raise your cut by $${amount} and still stay booked.`,
  };
}

/**
 * Compute the full Money Leak Scorecard.
 * Aggregates all sub-computations into a single response.
 */
async function computeFullScorecard(barberGhlId, locationId) {
  // Run sub-computations in parallel; isolate failures so one broken metric
  // doesn't take down the whole scorecard.
  const safeCompute = async (fn, fallback) => {
    try { return await fn(); } catch (err) {
      console.error(`⚠️ Scorecard sub-computation failed: ${err.message}`);
      return fallback;
    }
  };

  const [
    moneyOnTheFloor,
    rebookAttempt,
    weeklyGoalData,
    currentPaceData,
  ] = await Promise.all([
    safeCompute(() => computeMoneyOnTheFloor(barberGhlId, locationId), {
      totalAmount: null, lostRegulars: null, annualValuePerRegular: null,
      nonRegularCount: 0, recentNewClients: 0, currentRebookRate: null,
      goalRebookRate: 55, conversionGap: null, avgRevenuePerVisit: null,
      avgFrequencyDays: null, visitsPerYear: null, chairUtilization: null,
      insufficientData: true,
    }),
    safeCompute(() => computeRebookAttemptRate(barberGhlId, locationId, 90), {
      attemptRate: null, totalCompleted: 0, bookedNextVisit: 0, didNotBook: 0,
      bookedAndReturned: 0, bookedAndDidNotReturn: 0,
      didNotBookAndReturned: 0, didNotBookAndLost: 0,
    }),
    safeCompute(() => computeWeeklyGoal(barberGhlId, locationId), {
      goal: null, bestWeekRevenue: null, bestWeekDate: null,
    }),
    safeCompute(() => computeCurrentPace(barberGhlId, locationId), {
      pace: null, currentWeekRevenue: null, projectedFromBookings: null,
      bookedAppointmentCount: null, tipMultiplier: null, daysElapsed: null,
    }),
  ]);

  // Goal vs Pace
  const weeklyGoal = weeklyGoalData.goal;
  const currentPace = currentPaceData.pace;
  const delta = (weeklyGoal != null && currentPace != null)
    ? Math.round((currentPace - weeklyGoal) * 100) / 100
    : null;

  // Cap Zone metrics — only computed when utilization >= 90%
  let capZoneMetrics = null;
  const zone = moneyOnTheFloor.capacityZone;
  if (zone === "cap") {
    const [avgRevPerHour, overflow, priceBump] = await Promise.all([
      safeCompute(() => computeAvgRevenuePerHour(barberGhlId, locationId), null),
      safeCompute(() => computeOverflowDemand(barberGhlId, locationId), { fullyBookedDays: 0, avgWaitDays: null }),
      safeCompute(() => computeSuggestedPriceBump(barberGhlId, locationId, moneyOnTheFloor.avgRevenuePerVisit), null),
    ]);
    capZoneMetrics = {
      avgRevenuePerHour: avgRevPerHour,
      overflowDemand: overflow,
      suggestedPriceBump: priceBump,
    };
  }

  return {
    moneyOnTheFloor,

    recentNewClients: moneyOnTheFloor.recentNewClients,

    rebookRate: {
      current: moneyOnTheFloor.currentRebookRate,
      goal: moneyOnTheFloor.goalRebookRate,
      chairUtilization: moneyOnTheFloor.chairUtilization,
    },

    capacityZone: {
      zone: moneyOnTheFloor.capacityZone,
      message: moneyOnTheFloor.zoneMessage,
      relevance: moneyOnTheFloor.zoneRelevance,
    },

    availability: {
      availabilityIndex: moneyOnTheFloor.availabilityIndex,
      shopImpact: moneyOnTheFloor.shopImpact,
      blockedPercent: moneyOnTheFloor.blockedPercent,
      atRisk: moneyOnTheFloor.atRisk,
    },

    capZoneMetrics,

    rebookAttemptRate: {
      rate: rebookAttempt.attemptRate,
      totalCompleted: rebookAttempt.totalCompleted,
      bookedNextVisit: rebookAttempt.bookedNextVisit,
      didNotBook: rebookAttempt.didNotBook,
      bookedAndReturned: rebookAttempt.bookedAndReturned,
      bookedAndDidNotReturn: rebookAttempt.bookedAndDidNotReturn,
      didNotBookAndReturned: rebookAttempt.didNotBookAndReturned,
      didNotBookAndLost: rebookAttempt.didNotBookAndLost,
    },

    goalVsPace: {
      weeklyGoal,
      currentPace,
      delta,
      bestWeekRevenue: weeklyGoalData.bestWeekRevenue,
      bestWeekDate: weeklyGoalData.bestWeekDate,
      currentWeekRevenue: currentPaceData.currentWeekRevenue,
      projectedFromBookings: currentPaceData.projectedFromBookings,
      bookedAppointmentCount: currentPaceData.bookedAppointmentCount,
      tipMultiplier: currentPaceData.tipMultiplier,
      daysElapsed: currentPaceData.daysElapsed,
    },

    snapshotDate: new Date().toISOString().split("T")[0],
  };
}

module.exports = {
  CAPACITY_ZONES,
  getCapacityZone,
  getGoalRebookRate,
  computeRebookAttemptRate,
  computeMoneyOnTheFloor,
  computeAvgRevenuePerHour,
  computeOverflowDemand,
  computeSuggestedPriceBump,
  findBestWeek,
  computeWeeklyGoal,
  computeCurrentPace,
  computeFullScorecard,
};
