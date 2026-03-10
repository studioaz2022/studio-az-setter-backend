// appointmentBackfill.js
// One-time backfill of GHL appointments into the Supabase appointments table.

const { supabase } = require("../clients/supabaseClient");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const { fetchAppointmentsForDateRange } = require("../clients/ghlCalendarClient");
const { mapGHLAppointmentToSupabase } = require("../clients/appointmentWebhooks");

const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID || "GLRkNAxfPtWTqTiN83xj";

/**
 * Backfill appointments from GHL into Supabase for a date range.
 * Fetches day-by-day to avoid GHL API limits on event count per request.
 *
 * Existing rows (from webhooks) are preserved — only new appointments are inserted.
 * This prevents overwriting reschedule_count/reschedule_history from live webhook data.
 *
 * @param {string} startDate - YYYY-MM-DD (inclusive)
 * @param {string} endDate   - YYYY-MM-DD (inclusive)
 * @returns {object} - { appointmentsInserted, appointmentsSkipped, daysProcessed, errors }
 */
async function backfillAppointments(startDate, endDate) {
  if (!ghlBarber) {
    throw new Error("GHL Barber SDK not configured — set GHL_BARBER_SHOP_TOKEN env var");
  }

  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T23:59:59Z");
  const results = { appointmentsInserted: 0, appointmentsSkipped: 0, daysProcessed: 0, errors: [], totalFetched: 0 };

  const currentDate = new Date(start);

  while (currentDate <= end) {
    const dayStart = new Date(currentDate);
    dayStart.setUTCHours(0, 0, 0, 0);

    const dayEnd = new Date(currentDate);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const dateStr = currentDate.toISOString().split("T")[0];

    try {
      // Fetch all appointments for this day across all calendars
      const events = await fetchAppointmentsForDateRange({
        locationId: BARBER_LOCATION_ID,
        startTime: dayStart.getTime(),
        endTime: dayEnd.getTime(),
        sdkInstance: ghlBarber,
      });

      results.totalFetched += events.length;

      if (events.length > 0) {
        // Map each event to Supabase schema
        const rows = events.map((event) => {
          const mapped = mapGHLAppointmentToSupabase(event);
          // Add reschedule tracking defaults (matching handleAppointmentCreated behavior)
          return {
            ...mapped,
            original_start_time: mapped.start_time,
            original_end_time: mapped.end_time,
            reschedule_count: 0,
            reschedule_history: [],
          };
        });

        // Filter out any rows missing required fields
        const validRows = rows.filter((row) => row.id && row.contact_id && row.calendar_id);
        const skippedInvalid = rows.length - validRows.length;
        if (skippedInvalid > 0) {
          console.log(`[Appt Backfill] ${dateStr}: skipped ${skippedInvalid} events missing required fields`);
        }

        if (validRows.length > 0) {
          // Use ignoreDuplicates to preserve existing rows (from webhooks) that may have
          // reschedule_count, reschedule_history, etc. already set correctly.
          // Only genuinely new rows get inserted.
          for (let i = 0; i < validRows.length; i += 100) {
            const batch = validRows.slice(i, i + 100);
            const { data, error: upsertError } = await supabase
              .from("appointments")
              .upsert(batch, { onConflict: "id", ignoreDuplicates: true })
              .select("id");

            if (upsertError) {
              results.errors.push({ date: dateStr, error: upsertError.message, count: batch.length });
              console.error(`[Appt Backfill] Upsert error on ${dateStr}:`, upsertError.message);
            } else {
              // ignoreDuplicates: rows that already existed are skipped (not returned in data)
              const inserted = data ? data.length : batch.length;
              results.appointmentsInserted += inserted;
              results.appointmentsSkipped += batch.length - inserted;
            }
          }
        }
      }

      console.log(`[Appt Backfill] ${dateStr}: ${events.length} events fetched`);
    } catch (err) {
      results.errors.push({ date: dateStr, error: err.message });
      console.error(`[Appt Backfill] Error on ${dateStr}:`, err.message);
    }

    results.daysProcessed++;

    // Rate limit: small delay between days to avoid GHL API throttling
    await new Promise((resolve) => setTimeout(resolve, 200));

    currentDate.setDate(currentDate.getDate() + 1);
  }

  console.log(
    `[Appt Backfill] Complete: ${results.appointmentsInserted} inserted, ${results.appointmentsSkipped} skipped (existing), ${results.daysProcessed} days, ${results.errors.length} errors`
  );
  return results;
}

module.exports = { backfillAppointments };
