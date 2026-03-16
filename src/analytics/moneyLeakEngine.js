// moneyLeakEngine.js
// Money Leak Scorecard computation engine.
// Computes the full scorecard: money on the floor, rebook attempt rate,
// weekly goal vs pace, and focus metrics.

const { supabase, fetchAllRows } = require("../clients/supabaseClient");
const {
  getRebookingRate,
  getActiveClientCount,
  getAvgRevenuePerVisit,
  getVisitFrequencyDistribution,
  getChairUtilization,
} = require("./analyticsQueries");
const { BARBER_LOCATION_ID } = require("../config/kioskConfig");

// Completed appointment statuses (mirrored from analyticsQueries)
const COMPLETED_STATUSES = ["showed", "confirmed"];

/**
 * Dynamic goal rebook rate based on chair utilization.
 * Continuous piecewise function: more empty chairs → higher goal.
 */
function getGoalRebookRate(utilizationPct) {
  if (utilizationPct == null) return 55; // default mid-range
  if (utilizationPct <= 50) return 65;
  if (utilizationPct <= 70) return 65 - (utilizationPct - 50) * 0.5;   // 65 → 55
  if (utilizationPct <= 80) return 55 - (utilizationPct - 70) * 1.0;   // 55 → 45
  if (utilizationPct <= 90) return 45 - (utilizationPct - 80) * 1.5;   // 45 → 30
  return Math.max(15, 30 - (utilizationPct - 90) * 1.5);               // 30 → 15
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

  // Also get ALL appointments (including future/pending) to check for bookings created same day
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
    if (!appt.start_time || !appt.contact_id) continue; // skip bad data
    const apptDate = appt.start_time.substring(0, 10); // "YYYY-MM-DD"
    const contactBookings = bookingsByContact[appt.contact_id] || [];

    // Check if a future appointment was created on the same day as this appointment.
    // Use created_at first, fall back to ghl_created_at (GHL's dateAdded).
    const bookedSameDay = contactBookings.some(b => {
      if (b.start_time <= appt.start_time) return false;
      const creationDate = b.created_at || b.ghl_created_at;
      if (!creationDate) return false;
      return creationDate.substring(0, 10) === apptDate;
    });

    // Check if the client has any subsequent COMPLETED appointment
    const hasReturned = allAppointments.some(
      a => a.contact_id === appt.contact_id && a.start_time > appt.start_time
    );

    if (bookedSameDay) {
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
  const goalRebookRate = getGoalRebookRate(chairUtilization);
  const avgRevenuePerVisit = avgRevenue.avgRevenue;
  const avgFrequencyDays = frequency.avgFrequency;

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
 * Extrapolates based on days elapsed this week.
 */
async function computeCurrentPace(barberGhlId, locationId) {
  // Get Monday of the current week (Central time)
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

  // Days elapsed (1 = Monday, 7 = Sunday)
  const daysElapsed = day === 0 ? 7 : day;

  // Get this week's revenue
  const { data: transactions, error } = await supabase
    .from("transactions")
    .select("gross_amount")
    .eq("artist_ghl_id", barberGhlId)
    .eq("location_id", locationId)
    .in("transaction_type", ["session_payment"])
    .gte("session_date", mondayStr)
    .lte("session_date", centralDateStr);

  if (error) throw new Error(`Current pace query failed: ${error.message}`);

  let currentWeekRevenue = 0;
  for (const t of (transactions || [])) {
    currentWeekRevenue += parseFloat(t.gross_amount || 0);
  }
  currentWeekRevenue = Math.round(currentWeekRevenue * 100) / 100;

  // Extrapolate: assume 5 work days per week (can refine with GHL schedule later)
  const workDaysPerWeek = 5;
  const pace = daysElapsed > 0
    ? Math.round((currentWeekRevenue / Math.min(daysElapsed, workDaysPerWeek)) * workDaysPerWeek * 100) / 100
    : null;

  return {
    pace,
    currentWeekRevenue,
    daysElapsed,
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
      pace: null, currentWeekRevenue: null, daysElapsed: null,
    }),
  ]);

  // Goal vs Pace
  const weeklyGoal = weeklyGoalData.goal;
  const currentPace = currentPaceData.pace;
  const delta = (weeklyGoal != null && currentPace != null)
    ? Math.round((currentPace - weeklyGoal) * 100) / 100
    : null;

  return {
    moneyOnTheFloor,

    recentNewClients: moneyOnTheFloor.recentNewClients,

    rebookRate: {
      current: moneyOnTheFloor.currentRebookRate,
      goal: moneyOnTheFloor.goalRebookRate,
      chairUtilization: moneyOnTheFloor.chairUtilization,
    },

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
      daysElapsed: currentPaceData.daysElapsed,
    },

    snapshotDate: new Date().toISOString().split("T")[0],
  };
}

module.exports = {
  getGoalRebookRate,
  computeRebookAttemptRate,
  computeMoneyOnTheFloor,
  findBestWeek,
  computeWeeklyGoal,
  computeCurrentPace,
  computeFullScorecard,
};
