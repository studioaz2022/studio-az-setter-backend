/**
 * Payment Push Notification Service
 * Sends APNs push notifications when payments complete:
 * - Stripe financing (Affirm/Klarna/card)
 * - Square deposits
 *
 * Notifies the artist assigned to the contact.
 */

const { supabase } = require('../clients/supabaseClient');
const apnsService = require('./apnsService');

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

    console.log(`📱 [PAY APN] ${notification.type}: sent to ${sent} device(s) for GHL user ${ghlUserId}`);
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

  return sendPushToGhlUser(artistGhlUserId, notification);
}

module.exports = {
  sendPaymentReceivedNotification,
};
