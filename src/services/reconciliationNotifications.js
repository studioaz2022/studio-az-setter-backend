/**
 * Reconciliation Push Notifications (Phase 5)
 *
 * Two notification flavors:
 *   - settled  → "Your $1,260 reconciliation just settled ✓"
 *   - please_confirm → "Possible Venmo match — please confirm in the Finance tab"
 *
 * Routed through the existing APNs pipeline via sendPushToGhlUser (which
 * already handles GHL user → Supabase profile → push_tokens lookup).
 *
 * See TATTOO_FINANCE_PLAN.md Phase 5.
 */

const { sendPushToGhlUser } = require("./taskNotifications");

/**
 * Format a dollar amount for push body (no decimals when round dollars).
 */
function fmtAmount(amount) {
  const n = Math.abs(Number(amount) || 0);
  return n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

/**
 * Notify the artist their reconciliation just auto-settled via Venmo.
 *
 * @param {object} args
 * @param {string} args.artistGhlUserId   — artist's GHL USER id (not contact id)
 * @param {number} args.amount            — net amount (always positive in display)
 * @param {string} args.weekRange         — "Apr 27-May 3"
 * @param {string} args.reconciliationId  — UUID of the settled row
 */
async function sendReconciliationSettledNotification({
  artistGhlUserId,
  amount,
  weekRange,
  reconciliationId,
}) {
  const dollar = fmtAmount(amount);
  const notification = (language) => {
    const isSpanish = language === "es";
    return {
      type: "reconciliation_settled",
      title: isSpanish ? "Liquidación Completada" : "Reconciliation Settled",
      body: isSpanish
        ? `Tu liquidación de ${dollar} (${weekRange}) se procesó por Venmo ✓`
        : `Your ${dollar} (${weekRange}) reconciliation just settled via Venmo ✓`,
      reconciliationId: reconciliationId || null,
    };
  };
  return sendPushToGhlUser(artistGhlUserId, notification);
}

/**
 * Notify the artist that an incoming Venmo couldn't be confidently matched —
 * they should open the Finance tab and tap Mark Settled manually.
 *
 * @param {object} args
 * @param {string} args.artistGhlUserId
 * @param {number} args.amount
 * @param {string} args.reason         — short reason ("amount mismatch", "no code", etc.)
 */
async function sendReconciliationConfirmNotification({
  artistGhlUserId,
  amount,
  reason,
}) {
  const dollar = fmtAmount(amount);
  const notification = (language) => {
    const isSpanish = language === "es";
    return {
      type: "reconciliation_please_confirm",
      title: isSpanish ? "Confirmar Pago Venmo" : "Confirm Venmo Match",
      body: isSpanish
        ? `Posible coincidencia de ${dollar} — abre la pestaña Finanzas para confirmar (${reason})`
        : `Possible ${dollar} match — open Finance tab to confirm (${reason})`,
    };
  };
  return sendPushToGhlUser(artistGhlUserId, notification);
}

module.exports = {
  sendReconciliationSettledNotification,
  sendReconciliationConfirmNotification,
};
