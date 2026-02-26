/**
 * One-time script to fix stale transaction amounts.
 * Transactions recorded before the amount calculation fix have:
 *   gross_amount = amount_money (should be total_money)
 *   service_price = amount_money - tip (should be amount_money)
 *
 * This script fetches the actual Square payment for each transaction
 * and updates the amounts if they differ.
 *
 * Usage: cd studio-az-setter-backend && node scripts/fix-transaction-amounts.js
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
    .select("access_token, barber_ghl_id")
    .single();

  if (tokenErr || !tokenRow) {
    console.error("Failed to get Square token:", tokenErr);
    return;
  }

  const accessToken = tokenRow.access_token;

  // Get all Square transactions
  const { data: transactions, error: txErr } = await supabase
    .from("transactions")
    .select("id, square_payment_id, gross_amount, service_price, tip_amount, contact_name, session_date")
    .eq("payment_method", "square")
    .not("square_payment_id", "is", null);

  if (txErr) {
    console.error("Failed to fetch transactions:", txErr);
    return;
  }

  console.log(`Found ${transactions.length} Square transactions to check`);

  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const tx of transactions) {
    try {
      const res = await axios.get(
        `${SQUARE_BASE_URL}/v2/payments/${tx.square_payment_id}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const payment = res.data.payment;
      if (!payment) { skipped++; continue; }

      const correctGross = (payment.total_money?.amount || payment.amount_money?.amount || 0) / 100;
      const correctService = (payment.amount_money?.amount || 0) / 100;
      const correctTip = (payment.tip_money?.amount || 0) / 100;

      const grossDiff = Math.abs(Number(tx.gross_amount) - correctGross) > 0.01;
      const serviceDiff = tx.service_price !== null && Math.abs(Number(tx.service_price) - correctService) > 0.01;
      const tipDiff = tx.tip_amount !== null && Math.abs(Number(tx.tip_amount) - correctTip) > 0.01;

      if (grossDiff || serviceDiff || tipDiff) {
        const update = { gross_amount: correctGross };
        if (tx.service_price !== null) update.service_price = correctService;
        if (tx.tip_amount !== null) update.tip_amount = correctTip;

        const { error: updateErr } = await supabase
          .from("transactions")
          .update(update)
          .eq("id", tx.id);

        if (updateErr) {
          console.error(`  ERROR updating ${tx.contact_name}: ${updateErr.message}`);
          errors++;
        } else {
          console.log(`  FIXED ${tx.contact_name} (${tx.session_date}): gross $${tx.gross_amount}->$${correctGross}, svc $${tx.service_price}->$${correctService}, tip $${tx.tip_amount}->$${correctTip}`);
          fixed++;
        }
      } else {
        skipped++;
      }

      // Rate limit: 100ms between Square API calls
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      if (err.response?.status === 404) {
        console.warn(`  SKIP ${tx.contact_name}: Square payment ${tx.square_payment_id} not found (deleted?)`);
        skipped++;
      } else {
        console.error(`  ERROR ${tx.contact_name}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${skipped} already correct, ${errors} errors`);
}

main().catch(console.error);
