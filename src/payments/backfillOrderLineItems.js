// backfillOrderLineItems.js
//
// Go back and get the Square order for rows that never stored one, so old
// tickets can still show that they bought more than one haircut.
//
// Two separate gaps to close on historical data:
//   - square_order_id is null on 411 of 1,197 rows, because
//     assignUnmatchedPayment() omitted it from its insert. The id was always on
//     the Square payment; we just never wrote it down.
//   - order_line_items is null on everything predating 2026-09-08, because
//     fetchSquareOrderDetails() only ever read line_items[0].
//
// Both are recoverable: Square still has the payment and the order. Heidi
// Girod's $92 is two $40 "Haircut" lines and Matthew Walters' $162.50 is a $65
// haircut plus a $60 custom amount — but only if we go and look.
//
// Read-only against Square. The only writes are to our own rows, and only to
// columns that were empty.

const axios = require("axios");
const { supabase } = require("../clients/supabaseClient");
const { getBarberToken } = require("./squareOAuth");

const IS_PROD = process.env.SQUARE_ENVIRONMENT === "production";
const SQUARE_BASE_URL = IS_PROD ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} barberGhlId
 * @param {object} [options]
 * @param {string} [options.since]  ISO date; only rows on/after this session_date
 * @param {number} [options.limit]  Safety cap on rows touched in one run
 * @param {boolean} [options.dryRun] Report only, write nothing
 */
async function backfillOrderLineItems(barberGhlId, options = {}) {
  const since = options.since || "2026-01-01";
  const limit = options.limit || 400;
  const dryRun = !!options.dryRun;

  const tokenRow = await getBarberToken(barberGhlId);
  if (!tokenRow) throw new Error(`No Square connection for ${barberGhlId}`);
  const token = tokenRow.access_token;

  const { data: rows, error } = await supabase
    .from("transactions")
    .select("id, square_payment_id, square_order_id, session_date")
    .eq("artist_ghl_id", barberGhlId)
    .eq("payment_method", "square")
    .is("deleted_at", null)
    .is("superseded_by", null)
    .is("order_line_items", null)
    .not("square_payment_id", "is", null)
    .gte("session_date", since)
    .order("session_date", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Row load failed: ${error.message}`);

  const stats = {
    considered: rows?.length || 0,
    updated: 0,
    multiService: 0,
    orderIdRecovered: 0,
    noOrder: 0,
    failed: 0,
    examples: [],
  };

  for (const row of rows || []) {
    try {
      let orderId = row.square_order_id;

      if (!orderId) {
        const p = await axios.get(`${SQUARE_BASE_URL}/v2/payments/${row.square_payment_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        orderId = p.data?.payment?.order_id || null;
        if (orderId) stats.orderIdRecovered++;
        await sleep(120);
      }

      if (!orderId) {
        stats.noOrder++;
        continue;
      }

      const o = await axios.get(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      await sleep(120);

      const items = (o.data?.order?.line_items || []).map((li) => ({
        name: li.name || null,
        quantity: parseInt(li.quantity, 10) || 1,
        itemType: li.item_type || null,
        basePriceCents: li.base_price_money?.amount ?? null,
        totalCents: li.total_money?.amount ?? null,
        catalogObjectId: li.catalog_object_id || null,
      }));

      const productish = (li) =>
        li.itemType === "ITEM" && li.catalogObjectId &&
        !["haircut", "beard"].some((s) => (li.name || "").toLowerCase().includes(s));
      const serviceItemCount = items
        .filter((li) => !productish(li))
        .reduce((sum, li) => sum + (li.quantity || 1), 0);

      if (serviceItemCount > 1) {
        stats.multiService++;
        if (stats.examples.length < 12) {
          stats.examples.push({
            transactionId: row.id,
            sessionDate: row.session_date,
            services: serviceItemCount,
            items: items.map((li) => `${li.name || li.itemType} $${(li.totalCents || 0) / 100}`).join(" + "),
          });
        }
      }

      if (!dryRun) {
        const { error: updErr } = await supabase
          .from("transactions")
          .update({
            square_order_id: orderId,
            order_line_items: items.length ? items : null,
            service_item_count: serviceItemCount,
          })
          .eq("id", row.id);
        if (updErr) throw new Error(updErr.message);
      }
      stats.updated++;
    } catch (err) {
      stats.failed++;
      const status = err.response?.status;
      if (status !== 404) {
        console.warn(`[OrderBackfill] ${row.square_payment_id}: ${status || ""} ${err.message}`);
      }
    }
  }

  console.log(
    `[OrderBackfill] ${barberGhlId}: ${stats.updated}/${stats.considered} updated, ` +
      `${stats.orderIdRecovered} order ids recovered, ${stats.multiService} cover multiple services, ` +
      `${stats.noOrder} had no order, ${stats.failed} failed${dryRun ? " (DRY RUN)" : ""}`
  );
  return stats;
}

module.exports = { backfillOrderLineItems };
