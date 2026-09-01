/**
 * Payment Push Notification Service
 * Sends APNs push notifications when payments complete:
 * - Stripe financing (Affirm/Klarna/card)
 * - Square deposits
 *
 * Notifies the artist assigned to the contact AND every owner/admin, who run
 * the front desk and need to know money landed without owning the contact.
 */

const { supabase } = require('../clients/supabaseClient');
const apnsService = require('./apnsService');

/** profiles.role values that run the front desk. */
const ADMIN_ROLES = ['owner', 'admin'];

/**
 * Send push notification to a GHL user by their GHL user ID.
 * Reuses the same pattern as taskNotifications.js.
 */
async function sendPushToGhlUser(ghlUserId, notification) {
  if (!apnsService.isConfigured()) {
    console.log('⚠️ [PAY APN] APNs not configured, skipping');
    return { sent: 0, failed: 0 };
  }

  if (!ghlUserId) {
    return { sent: 0, failed: 0 };
  }

  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('ghl_user_id', ghlUserId)
      .single();

    if (profileError || !profile) {
      console.log(`⚠️ [PAY APN] No profile found for GHL user ${ghlUserId}`);
      return { sent: 0, failed: 0 };
    }

    const { data: tokens, error: tokenError } = await supabase
      .from('push_tokens')
      .select('token, language')
      .eq('user_id', profile.id)
      .eq('is_active', true);

    if (tokenError || !tokens || tokens.length === 0) {
      console.log(`⚠️ [PAY APN] No active tokens for user ${ghlUserId}`);
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;

    for (const tokenRecord of tokens) {
      try {
        // Localize notification if needed
        const localizedNotification = typeof notification === 'function'
          ? notification(tokenRecord.language)
          : notification;
        await apnsService.send(tokenRecord.token, localizedNotification);
        sent++;
      } catch (err) {
        console.error(`❌ [PAY APN] Failed to send to token: ${err.message}`);
        failed++;
      }
    }

    const label = typeof notification === 'function' ? notification('en').type : notification.type;
    console.log(`📱 [PAY APN] ${label}: sent to ${sent} device(s) for GHL user ${ghlUserId}`);
    return { sent, failed };
  } catch (error) {
    console.error('❌ [PAY APN] Error:', error.message || error);
    return { sent: 0, failed: 0 };
  }
}

/**
 * Notify artist that a payment was received.
 * @param {string} artistGhlUserId - GHL user ID of the assigned artist
 * @param {string} contactName - Client's name
 * @param {number} amount - Dollar amount collected
 * @param {string} paymentMethod - e.g. 'stripe_affirm', 'stripe_klarna', 'square'
 * @param {string} contactId - GHL contact ID
 */
async function sendPaymentReceivedNotification({ artistGhlUserId, contactName, amount, paymentMethod, contactId }) {
  const methodLabel = paymentMethod
    .replace('stripe_', '')
    .replace('affirm', 'Affirm')
    .replace('klarna', 'Klarna')
    .replace('card', 'Card')
    .replace('square', 'Square');

  const notification = (language) => {
    const isSpanish = language === 'es';
    return {
      type: 'payment_received',
      title: isSpanish ? 'Pago Recibido' : 'Payment Received',
      body: isSpanish
        ? `${contactName} pagó $${amount.toFixed(2)} por ${methodLabel}`
        : `${contactName} paid $${amount.toFixed(2)} via ${methodLabel}`,
      contactId: contactId || null,
    };
  };

  const artistResult = await sendPushToGhlUser(artistGhlUserId, notification);

  // The front desk (owner + admins) needs deposits too. They rarely own the
  // contact, so the artist-only push above never reached them.
  const adminResult = await notifyAdminsOfPayment({
    artistGhlUserId,
    contactName,
    amount,
    methodLabel,
    contactId,
  });

  return {
    sent: artistResult.sent + adminResult.sent,
    failed: artistResult.failed + adminResult.failed,
  };
}

/**
 * Fan a payment out to every owner/admin, skipping whoever already got the
 * artist push so nobody's phone buzzes twice for one payment.
 *
 * Their copy names the artist — an admin's first question about a deposit is
 * always "whose client?", which the artist's own copy doesn't need to answer.
 */
async function notifyAdminsOfPayment({ artistGhlUserId, contactName, amount, methodLabel, contactId }) {
  try {
    const { data: admins, error } = await supabase
      .from('profiles')
      .select('ghl_user_id, full_name')
      .in('role', ADMIN_ROLES)
      .not('ghl_user_id', 'is', null);

    if (error) {
      console.error('❌ [PAY APN] Admin lookup failed:', error.message);
      return { sent: 0, failed: 0 };
    }

    const recipients = (admins || []).filter((a) => a.ghl_user_id !== artistGhlUserId);
    if (recipients.length === 0) return { sent: 0, failed: 0 };

    let artistName = null;
    if (artistGhlUserId) {
      const { data: artist } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('ghl_user_id', artistGhlUserId)
        .maybeSingle();
      artistName = artist?.full_name ? artist.full_name.split(' ')[0] : null;
    }

    const notification = (language) => {
      const isSpanish = language === 'es';
      const base = isSpanish
        ? `${contactName} pagó $${amount.toFixed(2)} por ${methodLabel}`
        : `${contactName} paid $${amount.toFixed(2)} via ${methodLabel}`;
      return {
        type: 'payment_received',
        title: isSpanish ? 'Pago Recibido' : 'Payment Received',
        body: artistName ? `${base} — ${artistName}` : base,
        contactId: contactId || null,
      };
    };

    let sent = 0;
    let failed = 0;
    for (const admin of recipients) {
      const result = await sendPushToGhlUser(admin.ghl_user_id, notification);
      sent += result.sent;
      failed += result.failed;
    }
    console.log(`📱 [PAY APN] payment_received fanned out to ${recipients.length} admin(s)`);
    return { sent, failed };
  } catch (err) {
    // Never let the admin copy take down the artist's push.
    console.error('❌ [PAY APN] Admin fan-out error:', err.message || err);
    return { sent: 0, failed: 0 };
  }
}

module.exports = {
  sendPaymentReceivedNotification,
  // Exported for other owner-facing pushes (deposit refund approvals) that need
  // the same GHL user → profile → push_tokens resolution.
  sendPushToGhlUser,
};
