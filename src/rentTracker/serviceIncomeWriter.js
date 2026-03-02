/**
 * Service Income Writer — writes service income records to InstantDB.
 * Used by Square sync, Square webhook, and Venmo barber payment handlers
 * to mirror transactions into the rent tracker app.
 */

const { weekOfDate } = require("./tenantMatcher");

// Lionel's GHL user ID — only his transactions go to InstantDB for now
const LIONEL_GHL_ID = "1kFG5FWdUDhXLUX46snG";

/**
 * Write a service income record to InstantDB with dedup.
 *
 * @param {Object} params
 * @param {string} params.senderName - Client name
 * @param {number} params.amount - Total amount (including tip for services)
 * @param {string} params.method - "square" | "venmo"
 * @param {string} params.type - "service" | "deposit" | "product_sale"
 * @param {Date}   params.paidAt - When payment was received
 * @param {string} [params.notes] - Freeform notes
 * @param {string} [params.squarePaymentId] - Square payment ID for dedup
 * @param {string} [params.venmoTxId] - Venmo transaction ID for dedup
 * @param {string} [params.weekOf] - ISO Monday date (auto-calculated if not provided)
 * @param {string} params.location - "barbershop" | "tattoo"
 * @param {number} [params.tipAmount] - Tip portion (Square only)
 * @param {number} [params.servicePriceAmount] - Base charge before tip
 * @param {string} [params.barberGhlId] - GHL user ID (for guard check)
 */
async function writeServiceIncome(params) {
  // Guard: only write for Lionel for now
  if (params.barberGhlId && params.barberGhlId !== LIONEL_GHL_ID) {
    return { skipped: "not-lionel" };
  }

  const { db } = require("../clients/instantDb");
  const { id } = require("@instantdb/admin");

  const week = params.weekOf || weekOfDate(params.paidAt);

  // Dedup check
  if (params.squarePaymentId) {
    const { serviceIncome: existing } = await db.query({
      serviceIncome: { $: { where: { squarePaymentId: params.squarePaymentId } } },
    });
    if (existing.length > 0) {
      return { skipped: "duplicate-square", squarePaymentId: params.squarePaymentId };
    }
  }

  if (params.venmoTxId) {
    const { serviceIncome: existing } = await db.query({
      serviceIncome: { $: { where: { venmoTxId: params.venmoTxId } } },
    });
    if (existing.length > 0) {
      return { skipped: "duplicate-venmo", venmoTxId: params.venmoTxId };
    }
  }

  // Write record
  const recordId = id();
  await db.transact(
    db.tx.serviceIncome[recordId].update({
      senderName: params.senderName,
      amount: params.amount,
      method: params.method,
      type: params.type,
      paidAt: params.paidAt,
      notes: params.notes || undefined,
      squarePaymentId: params.squarePaymentId || undefined,
      venmoTxId: params.venmoTxId || undefined,
      verified: false,
      weekOf: week,
      location: params.location,
      tipAmount: params.tipAmount ?? undefined,
      servicePriceAmount: params.servicePriceAmount ?? undefined,
    })
  );

  console.log(`  [ServiceIncome] ✅ Written: $${params.amount} ${params.method} ${params.type} from ${params.senderName} → week ${week} (${params.location})`);
  return { written: true, id: recordId, weekOf: week };
}

module.exports = { writeServiceIncome, LIONEL_GHL_ID };
