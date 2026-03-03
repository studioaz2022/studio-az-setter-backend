const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { ghlBarber } = require("../src/clients/ghlMultiLocationSdk");

(async () => {
  const names = ["Trey Stoller", "Logan Dorion", "Bret Starkweather", "Andrew McGee"];

  for (const name of names) {
    const { data: tx } = await supabase.from("transactions")
      .select("contact_id, contact_name, session_date, square_payment_time")
      .ilike("contact_name", "%" + name + "%")
      .is("appointment_id", null)
      .limit(1)
      .maybeSingle();

    if (!tx) continue;

    const day = tx.session_date;
    const startOfDay = new Date(day + "T00:00:00-06:00");
    const endOfDay = new Date(day + "T23:59:59-06:00");

    try {
      // Try both haircut calendars
      let events = [];
      for (const calId of ["Bsv9ngkRgsbLzgtN3Vpq", "pGNsYjGyEYW9LCD1GcQN"]) {
        try {
          const result = await ghlBarber.calendars.getCalendarEvents({
            locationId: process.env.GHL_BARBER_LOCATION_ID,
            calendarId: calId,
            startTime: startOfDay.getTime(),
            endTime: endOfDay.getTime(),
          });
          events = events.concat((result?.events || []).filter(e =>
            ["confirmed", "showed", "new"].includes(e.appointmentStatus)
          ));
        } catch (e) { /* skip */ }
      }

      // Dedupe
      const seen = new Set();
      events = events.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });

      const nameMatch = events.find(e => {
        const title = (e.title || "").toLowerCase();
        return title.includes(name.toLowerCase());
      });

      console.log(name + " (" + day + "):");
      console.log("  tx contact_id:", tx.contact_id);
      if (nameMatch) {
        console.log("  APT FOUND:", nameMatch.id, "| title:", nameMatch.title, "| apt contactId:", nameMatch.contactId);
      } else {
        console.log("  No name match in", events.length, "appointments. Titles:");
        events.forEach(e => console.log("    -", (e.title || "").trim(), "| contactId:", e.contactId));
      }
    } catch (err) {
      console.log(name + ": Error -", err.message);
    }

    await new Promise(r => setTimeout(r, 200));
  }
})();
