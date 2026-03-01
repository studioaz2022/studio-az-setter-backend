/**
 * One-time script to backfill square_payment_time for existing transactions.
 * Fetches the actual payment.created_at from Square API for each transaction
 * that has a square_payment_id but no square_payment_time.
 *
 * Usage: cd studio-az-setter-backend && node scripts/backfill-square-payment-time.js
 */
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const SQUARE_BASE_URL = "https://connect.squareup.com";

async function main() {
  // Get barber's Square access token
  const { data: tokenRow, error: tokenErr } = await supabase
    .from("barber_square_tokens")
    .select("access_token")
    .single();

  if (tokenErr || !tokenRow) {
    console.error("Failed to get Square token:", tokenErr);
    return;
  }

  const accessToken = tokenRow.access_token;

  // Get all transactions with a square_payment_id but no square_payment_time
  const { data: transactions, error: txErr } = await supabase
    .from("transactions")
    .select("id, square_payment_id, contact_name, session_date")
    .not("square_payment_id", "is", null)
    .is("square_payment_time", null);

  if (txErr) {
    console.error("Failed to fetch transactions:", txErr);
    return;
  }

  console.log(`Found ${transactions.length} transactions to backfill`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const tx of transactions) {
    try {
      const res = await axios.get(
        `${SQUARE_BASE_URL}/v2/payments/${tx.square_payment_id}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const payment = res.data.payment;
      if (!payment || !payment.created_at) {
        skipped++;
        continue;
      }

      const { error: updateErr } = await supabase
        .from("transactions")
        .update({ square_payment_time: payment.created_at })
        .eq("id", tx.id);

      if (updateErr) {
        console.error(`  ERROR updating ${tx.contact_name}: ${updateErr.message}`);
        errors++;
      } else {
        console.log(`  OK ${tx.contact_name} (${tx.session_date}): ${payment.created_at}`);
        updated++;
      }

      // Rate limit: 100ms between Square API calls
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      if (err.response?.status === 404) {
        console.warn(`  SKIP ${tx.contact_name}: payment ${tx.square_payment_id} not found`);
        skipped++;
      } else {
        console.error(`  ERROR ${tx.contact_name}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log(`\nDone: ${updated} updated, ${skipped} skipped, ${errors} errors`);
}

main().catch(console.error);
