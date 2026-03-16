// backfillCreatedAt.js
// Targeted backfill: fetch the real creation timestamp (dateAdded) from GHL
// for appointments that have ghl_created_at = NULL.
//
// Usage (from project root):
//   node -e "require('./src/analytics/backfillCreatedAt').backfillCreatedAtForBarber('1kFG5FWdUDhXLUX46snG')"
//
// Or via the API endpoint (if wired up):
//   POST /api/barbers/:barberGhlId/analytics/backfill-created-at

const { supabase, fetchAllRows } = require("../clients/supabaseClient");
const { ghlBarber } = require("../clients/ghlMultiLocationSdk");
const { BARBER_LOCATION_ID } = require("../config/kioskConfig");

const DELAY_MS = 250; // delay between API calls to avoid rate limiting

/**
 * Fetch appointments with null ghl_created_at for a specific barber,
 * look up each one individually via GHL getAppointment(), and update
 * the ghl_created_at + created_at columns in Supabase.
 */
async function backfillCreatedAtForBarber(barberGhlId) {
  if (!ghlBarber) {
    throw new Error("GHL Barber SDK not configured — set GHL_BARBER_SHOP_TOKEN env var");
  }

  console.log(`[CreatedAt Backfill] Starting for barber ${barberGhlId}...`);

  // 1. Find all appointments with null ghl_created_at for this barber
  const { data: appointments, error } = await fetchAllRows(supabase
    .from("appointments")
    .select("id")
    .eq("assigned_user_id", barberGhlId)
    .eq("location_id", BARBER_LOCATION_ID)
    .is("ghl_created_at", null)
    .order("start_time", { ascending: true }));

  if (error) throw new Error(`Query for null ghl_created_at failed: ${error.message}`);

  const count = (appointments || []).length;
  console.log(`[CreatedAt Backfill] Found ${count} appointments with null ghl_created_at`);

  if (count === 0) {
    return { total: 0, updated: 0, notFound: 0, errors: 0 };
  }

  let updated = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < count; i++) {
    const appt = appointments[i];

    try {
      // Fetch individual appointment from GHL
      const result = await ghlBarber.calendars.getAppointment({
        eventId: appt.id,
      });

      const event = result?.data || result;
      const dateAdded = event?.dateAdded || event?.event?.dateAdded || null;

      if (dateAdded) {
        // Update both columns: ghl_created_at (the real GHL timestamp)
        // and created_at (used by rebook attempt proxy)
        const { error: updateError } = await supabase
          .from("appointments")
          .update({
            ghl_created_at: dateAdded,
            created_at: dateAdded, // overwrite the start_time fallback with real creation time
          })
          .eq("id", appt.id);

        if (updateError) {
          console.error(`[CreatedAt Backfill] Update failed for ${appt.id}: ${updateError.message}`);
          errors++;
        } else {
          updated++;
        }
      } else {
        // GHL doesn't have dateAdded for this appointment
        notFound++;
      }
    } catch (err) {
      // 404 = appointment deleted in GHL but still in our DB
      if (err?.response?.status === 404 || err?.statusCode === 404) {
        notFound++;
      } else {
        console.error(`[CreatedAt Backfill] Error fetching ${appt.id}: ${err.message}`);
        errors++;
      }
    }

    // Progress log every 50 appointments
    if ((i + 1) % 50 === 0) {
      console.log(`[CreatedAt Backfill] Progress: ${i + 1}/${count} (${updated} updated, ${notFound} not found, ${errors} errors)`);
    }

    // Rate limit
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  const summary = {
    total: count,
    updated,
    notFound,
    errors,
  };

  console.log(`[CreatedAt Backfill] Complete:`, summary);
  return summary;
}

module.exports = { backfillCreatedAtForBarber };
