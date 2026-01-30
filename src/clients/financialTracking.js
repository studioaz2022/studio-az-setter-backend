// financialTracking.js
// Financial tracking functions for client lifetime value and artist commissions

const { supabase } = require('./supabaseClient');
const { getContact } = require('./ghlClient');

/**
 * Get artist commission rate from database
 */
async function getArtistCommissionRate(artistId, locationId) {
  if (!supabase) {
    console.log('[Financial] Supabase not initialized, using default 50/50 split');
    return {
      shop_percentage: 50,
      artist_percentage: 50
    };
  }

  console.log(`[Financial] Getting commission rate for artist: ${artistId}`);

  const { data, error } = await supabase
    .from('artist_commission_rates')
    .select('*')
    .eq('artist_ghl_id', artistId)
    .eq('location_id', locationId)
    .is('effective_to', null)  // Current rate (no end date)
    .single();

  if (error || !data) {
    console.log(`[Financial] No custom rate found, using default 50/50 split`);
    // Default to 50/50 split if no rate found
    return {
      shop_percentage: 50,
      artist_percentage: 50
    };
  }

  console.log(`[Financial] Found rate: Shop ${data.shop_percentage}% / Artist ${data.artist_percentage}%`);
  return data;
}

/**
 * Record a transaction in the database
 */
async function recordTransaction({
  contactId,
  contactName,
  appointmentId,
  artistId,
  transactionType,
  paymentMethod,
  paymentRecipient,
  grossAmount,
  sessionDate,
  squarePaymentId,
  locationId,
  notes
}) {
  if (!supabase) {
    console.log('[Financial] Supabase not initialized, skipping transaction recording');
    return null;
  }

  console.log(`[Financial] Recording transaction: $${grossAmount} for ${contactName}`);

  // Get commission rate
  const commissionRate = await getArtistCommissionRate(artistId, locationId);

  // Calculate amounts
  const shopAmount = (grossAmount * commissionRate.shop_percentage) / 100;
  const artistAmount = (grossAmount * commissionRate.artist_percentage) / 100;

  // Determine settlement status based on who received payment
  let settlementStatus = 'pending';
  if (paymentRecipient === 'shop') {
    // Shop has the money, artist is owed
    settlementStatus = artistAmount === 0 ? 'settled' : 'pending';
  } else if (paymentRecipient === 'artist_direct') {
    // Artist has the money, shop is owed
    settlementStatus = shopAmount === 0 ? 'settled' : 'pending';
  }

  const transaction = {
    contact_id: contactId,
    contact_name: contactName,
    appointment_id: appointmentId,
    artist_ghl_id: artistId,
    transaction_type: transactionType,
    payment_method: paymentMethod,
    payment_recipient: paymentRecipient,
    gross_amount: grossAmount,
    shop_percentage: commissionRate.shop_percentage,
    artist_percentage: commissionRate.artist_percentage,
    shop_amount: shopAmount,
    artist_amount: artistAmount,
    settlement_status: settlementStatus,
    square_payment_id: squarePaymentId,
    session_date: sessionDate,
    location_id: locationId,
    notes: notes
  };

  const { data, error } = await supabase
    .from('transactions')
    .insert(transaction)
    .select()
    .single();

  if (error) {
    console.error(`[Financial] Error recording transaction:`, error);
    throw error;
  }

  console.log(`[Financial] Transaction recorded: ${data.id}`);

  // Update client financials
  await updateClientFinancials(contactId);

  return data;
}

/**
 * Update client lifetime value and financial summary
 */
async function updateClientFinancials(contactId) {
  if (!supabase) {
    console.log('[Financial] Supabase not initialized, skipping client financials update');
    return;
  }

  console.log(`[Financial] Updating client financials for: ${contactId}`);

  // Get all transactions for this contact
  const { data: transactions, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('contact_id', contactId);

  if (txError) {
    console.error(`[Financial] Error fetching transactions:`, txError);
    return;
  }

  if (!transactions || transactions.length === 0) {
    console.log(`[Financial] No transactions found for contact`);
    return;
  }

  // Calculate totals
  let totalSpent = 0;
  let totalDeposits = 0;
  let totalSessions = 0;
  let totalTips = 0;
  let completedTattoos = 0;
  let firstAppointmentDate = null;
  let lastAppointmentDate = null;
  let lastPaymentDate = null;

  for (const tx of transactions) {
    totalSpent += parseFloat(tx.gross_amount) || 0;

    switch (tx.transaction_type) {
      case 'deposit':
        totalDeposits += parseFloat(tx.gross_amount) || 0;
        break;
      case 'session_payment':
        totalSessions += parseFloat(tx.gross_amount) || 0;
        completedTattoos++;
        break;
      case 'tip':
        totalTips += parseFloat(tx.gross_amount) || 0;
        break;
    }

    // Track dates
    const txDate = new Date(tx.session_date || tx.created_at);
    if (!firstAppointmentDate || txDate < firstAppointmentDate) {
      firstAppointmentDate = txDate;
    }
    if (!lastAppointmentDate || txDate > lastAppointmentDate) {
      lastAppointmentDate = txDate;
    }

    const paymentDate = new Date(tx.created_at);
    if (!lastPaymentDate || paymentDate > lastPaymentDate) {
      lastPaymentDate = paymentDate;
    }
  }

  // Determine if returning client (more than 1 completed tattoo or multiple deposits)
  const isReturningClient = completedTattoos > 1 || transactions.length > 2;

  // Get location_id from the first transaction
  const locationId = transactions[0]?.location_id || 'mUemx2jG4wly4kJWBkI4';

  // Upsert client financials
  const { error: upsertError } = await supabase
    .from('client_financials')
    .upsert({
      contact_id: contactId,
      contact_name: transactions[0]?.contact_name || 'Unknown',
      total_spent: totalSpent,
      total_deposits: totalDeposits,
      total_sessions: totalSessions,
      total_tips: totalTips,
      total_appointments: transactions.length,
      completed_tattoos: completedTattoos,
      first_appointment_date: firstAppointmentDate?.toISOString(),
      last_appointment_date: lastAppointmentDate?.toISOString(),
      last_payment_date: lastPaymentDate?.toISOString(),
      is_returning_client: isReturningClient,
      location_id: locationId,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'contact_id'
    });

  if (upsertError) {
    console.error(`[Financial] Error upserting client financials:`, upsertError);
    return;
  }

  console.log(`[Financial] Client financials updated. LTV: $${totalSpent.toFixed(2)}, Returning: ${isReturningClient}`);

  // Optionally update GHL custom fields
  try {
    await updateGHLClientFinancials(contactId, {
      totalSpent,
      completedTattoos,
      lastPaymentDate
    });
  } catch (ghlError) {
    console.error(`[Financial] Error updating GHL fields:`, ghlError);
    // Don't throw - GHL update is optional
  }
}

/**
 * Update GHL contact custom fields with financial data
 */
async function updateGHLClientFinancials(contactId, financials) {
  // Use GHL_FILE_UPLOAD_TOKEN as the primary API key
  const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;

  if (!GHL_API_KEY) {
    console.log(`[Financial] No GHL API key, skipping custom field update`);
    return;
  }

  try {
    const axios = require('axios');
    
    const response = await axios.put(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        customFields: [
          { key: 'client_lifetime_value', value: financials.totalSpent?.toString() || '0' },
          { key: 'total_tattoos_completed', value: financials.completedTattoos?.toString() || '0' },
          { key: 'last_payment_date', value: financials.lastPaymentDate?.toISOString()?.split('T')[0] || '' }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );

    if (response.status === 200) {
      console.log(`[Financial] GHL custom fields updated for contact ${contactId}`);
    }
  } catch (error) {
    console.error(`[Financial] GHL update failed:`, error.message || error);
    throw error;
  }
}

/**
 * Check if a Square payment has already been processed
 */
async function isPaymentAlreadyProcessed(squarePaymentId) {
  if (!supabase) {
    console.log('[Financial] Supabase not initialized, cannot check for duplicate payments');
    return false;
  }

  const { data, error } = await supabase
    .from('transactions')
    .select('id')
    .eq('square_payment_id', squarePaymentId)
    .single();

  // Handle errors properly
  if (error) {
    // PGRST116 = "not found" - this is expected when payment hasn't been processed
    if (error.code === 'PGRST116') {
      return false; // Payment not found, safe to process
    }
    
    // Any other error (connection, query, etc.) - throw to let caller handle it
    console.error('[Financial] Database error checking payment status:', error);
    throw new Error(`Failed to check payment status: ${error.message || error.code}`);
  }

  // No error, check if we found a record
  return !!data;
}

/**
 * Handle Square payment financial tracking
 */
async function handleSquarePaymentFinancials(payment, contactId, contactName, artistId) {
  console.log(`[Financial] Processing Square payment: ${payment.id}`);

  try {
    // Get amount in dollars (Square sends cents)
    const amountCents = payment.amount_money?.amount || payment.total_money?.amount || 0;
    const amount = amountCents / 100;

    console.log(`[Financial] Payment amount: $${amount}`);

    // Determine transaction type based on amount
    let transactionType = 'session_payment';
    if (amount === 50) {
      transactionType = 'deposit';
    } else if (amount < 50) {
      transactionType = 'tip';
    }

    // Record the transaction
    const transaction = await recordTransaction({
      contactId: contactId,
      contactName: contactName || 'Unknown Client',
      appointmentId: null, // Could be enhanced to link to appointment
      artistId: artistId || 'unknown',
      transactionType: transactionType,
      paymentMethod: 'square',
      paymentRecipient: 'shop', // Square payments go to shop
      grossAmount: amount,
      sessionDate: new Date(),
      squarePaymentId: payment.id,
      locationId: process.env.GHL_LOCATION_ID || 'studio_az_tattoo',
      notes: `Square payment ${payment.id}`
    });

    console.log(`[Financial] Successfully recorded Square payment`);
    return transaction;

  } catch (error) {
    console.error(`[Financial] Error processing payment financials:`, error);
    throw error;
  }
}

module.exports = {
  getArtistCommissionRate,
  recordTransaction,
  updateClientFinancials,
  updateGHLClientFinancials,
  isPaymentAlreadyProcessed,
  handleSquarePaymentFinancials,
};
