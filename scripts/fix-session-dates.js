/**
 * One-time script to fix session_date for transactions where the UTC date
 * differs from the local (Central time) date.
 *
 * Usage: cd studio-az-setter-backend && node scripts/fix-session-dates.js
 */
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BARBER_TZ = "America/Chicago";

function toLocalDate(utcIsoString) {
  const dt = new Date(utcIsoString);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BARBER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
}

async function main() {
  const { data: all, error } = await supabase
    .from("transactions")
    .select("id, contact_name, session_date, square_payment_time")
    .not("square_payment_time", "is", null);

  if (error) {
    console.error("Failed to fetch:", error);
    return;
  }

  let fixed = 0;
  let correct = 0;

  for (const tx of all) {
    const localDate = toLocalDate(tx.square_payment_time);
    if (tx.session_date !== localDate) {
      const { error: updateErr } = await supabase
        .from("transactions")
        .update({ session_date: localDate })
        .eq("id", tx.id);

      if (updateErr) {
        console.error(`  ERROR ${tx.contact_name}: ${updateErr.message}`);
      } else {
        console.log(`  FIXED ${tx.contact_name}: ${tx.session_date} → ${localDate}`);
        fixed++;
      }
    } else {
      correct++;
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${correct} already correct`);
}

main().catch(console.error);
