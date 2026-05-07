// appointmentBackfill.js
// One-time backfill of GHL appointments into the Supabase appointments table.

const { supabase } = require("../clients/supabaseClient");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const { fetchAppointmentsForDateRange } = require("../clients/ghlCalendarClient");
const { mapGHLAppointmentToSupabase } = require("../clients/appointmentWebhooks");
const { BARBER_DATA, BARBER_LOCATION_ID } = require("../config/kioskConfig");
const { getCentralDayBounds, toShopDateString } = require("../utils/dateUtils");

/**
 * Backfill appointments from GHL into Supabase for a date range.
 * Fetches day-by-day to avoid GHL API limits on event count per request.
 *
 * Existing rows (from webhooks) are preserved — only new appointments are inserted.
 * This prevents overwriting reschedule_count/reschedule_history from live webhook data.
 *
 * @param {string} startDate - YYYY-MM-DD (inclusive)
 * @param {string} endDate   - YYYY-MM-DD (inclusive)
 * @param {string} [barberGhlId] - Optional: only backfill for this barber's userId
 * @returns {object} - { appointmentsInserted, appointmentsSkipped, daysProcessed, errors }
 */
async function backfillAppointments(startDate, endDate, barberGhlId = null) {
  if (!ghlBarber) {
    throw new Error("GHL Barber SDK not configured — set GHL_BARBER_SHOP_TOKEN env var");
  }

  // Iterate day-by-day in shop-local (Central) time, not UTC.
  // Querying GHL with UTC midnight bounds causes cross-day bleed because UTC
  // midnight = 6/7pm CST the previous day. Shop dates are Central business days.
  const results = { appointmentsInserted: 0, appointmentsSkipped: 0, daysProcessed: 0, errors: [], totalFetched: 0 };

  // Build the list of Central-time YYYY-MM-DD dates between startDate and endDate (inclusive).
  const dateList = [];
  {
    let cursor = startDate;
    while (cursor <= endDate) {
      dateList.push(cursor);
      // Advance cursor by one day in Central time.
      const { startMs } = getCentralDayBounds(cursor);
      const next = new Date(startMs + 25 * 60 * 60 * 1000); // +25h to safely cross DST springs
      cursor = toShopDateString(next);
    }
  }

  for (const dateStr of dateList) {
    const { startMs: dayStartMs, endMs: dayEndMs } = getCentralDayBounds(dateStr);

    try {
      // GHL API requires userId — fetch per-barber and deduplicate by event ID
      const eventMap = new Map();
      const barbers = barberGhlId
        ? BARBER_DATA.filter((b) => b.ghlUserId === barberGhlId)
        : BARBER_DATA;
      for (const barber of barbers) {
        try {
          const barberEvents = await fetchAppointmentsForDateRange({
            locationId: BARBER_LOCATION_ID,
            startTime: dayStartMs,
            endTime: dayEndMs,
            userId: barber.ghlUserId,
            sdkInstance: ghlBarber,
          });
          for (const evt of barberEvents) {
            if (evt.id && !eventMap.has(evt.id)) {
              eventMap.set(evt.id, evt);
            }
          }
          // Small delay between barbers to avoid rate limiting
          if (BARBER_DATA.indexOf(barber) < BARBER_DATA.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (barberErr) {
          console.warn(`[Appt Backfill] ${dateStr}: error for ${barber.name}: ${barberErr.message}`);
        }
      }
      const events = Array.from(eventMap.values());

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
              // With ignoreDuplicates: true, `data` contains only the rows that were actually inserted.
              // Pre-existing rows (skipped due to id conflict) are not returned, so data.length === insertedCount.
              // If data is null/undefined for any reason, treat as 0 inserted (safer than assuming full batch).
              const inserted = Array.isArray(data) ? data.length : 0;
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
  }

  console.log(
    `[Appt Backfill] Complete: ${results.appointmentsInserted} inserted, ${results.appointmentsSkipped} skipped (existing), ${results.daysProcessed} days, ${results.errors.length} errors`
  );
  return results;
}

module.exports = { backfillAppointments };
