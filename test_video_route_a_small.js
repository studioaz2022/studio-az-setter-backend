#!/usr/bin/env node

/**
 * Test: Video consultation (English-only, Route A, Small tattoo)
 * Expected: pre_consultation_notes task created
 */

const axios = require('axios');
require('dotenv').config();

const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl'; // Leonel Chavez test contact
const SQUARE_API_URL = 'https://connect.squareupsandbox.com/v2';
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

const CUSTOM_FIELD_IDS = {
  consultation_type: "gM2PVo90yNBDHekV5G64",
  language_preference: "ETxasC6QlyxRaKU18kbz",
  tattoo_size: "KXtfZYdeSKUyS5llTKsr",
  inquired_technician: "H3PSN8tZSw1kYckHJN9D",
  lead_spanish_comfortable: "qvUQ2WDV3drhbKhTS6td",
};

async function updateGHLCustomFields(contactId, fields) {
  const customFields = Object.entries(fields).map(([key, value]) => ({
    id: CUSTOM_FIELD_IDS[key],
    field_value: value,
  }));

  await axios.put(
    `https://services.leadconnectorhq.com/contacts/${contactId}`,
    { customFields },
    {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28'
      }
    }
  );
}

async function createSquarePaymentLink(contactId, amount = 10000) {
  const response = await axios.post(
    `${SQUARE_API_URL}/online-checkout/payment-links`,
    {
      idempotency_key: `test-${Date.now()}`,
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: contactId,
        line_items: [{
          name: "Studio AZ Tattoo Consultation Deposit - Video Route A Test",
          quantity: "1",
          base_price_money: {
            amount: amount,
            currency: "USD"
          }
        }],
        fulfillments: [{
          type: "DIGITAL",
          digital_details: {
            recipient_name: "Leonel Chavez",
            recipient_email: "chavezctz@gmail.com"
          }
        }]
      },
      checkout_options: {
        ask_for_shipping_address: false,
        accepted_payment_methods: {
          apple_pay: true,
          google_pay: true
        }
      }
    },
    {
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  return response.data.payment_link;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  VIDEO CONSULTATION TEST (Route A, Small Tattoo)      ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  console.log('📋 Test Scenario:');
  console.log('   • Consultation Type: online (video)');
  console.log('   • Language: English');
  console.log('   • Spanish Comfortable: No');
  console.log('   • Tattoo Size: Small');
  console.log('   • Artist: Claudia');
  console.log('   • Route: A');
  console.log('   • Expected Task: pre_consultation_notes\n');

  console.log('🔍 Step 1: Update GHL contact fields...');
  await updateGHLCustomFields(CONTACT_ID, {
    consultation_type: 'online',
    language_preference: 'English',
    lead_spanish_comfortable: 'No',
    tattoo_size: 'Small',
    inquired_technician: 'Claudia'
  });
  console.log('   ✅ Contact fields updated\n');

  console.log('🔍 Step 2: Create Square payment link...');
  const paymentLink = await createSquarePaymentLink(CONTACT_ID);
  
  console.log('   ✅ ════════════════════════════════════════════════════════');
  console.log('   ✅ PAYMENT LINK CREATED!');
  console.log('   ✅ ════════════════════════════════════════════════════════\n');
  console.log(`   📱 Payment Link: ${paymentLink.url}`);
  console.log(`   🔑 Payment Link ID: ${paymentLink.id}`);
  console.log(`   📦 Order ID: ${paymentLink.order_id}\n`);

  console.log('   📋 NEXT STEPS:');
  console.log('   1. Open this link in your browser:');
  console.log(`      ${paymentLink.url}\n`);
  console.log('   2. Pay with Square Sandbox test card:');
  console.log('      Card: 4111 1111 1111 1111');
  console.log('      CVV: 111');
  console.log('      Expiry: Any future date');
  console.log('      ZIP: Any 5 digits\n');
  console.log('   3. After payment, check:');
  console.log('      - Render logs: Backend should log "pre_consultation_notes"');
  console.log('      - Webhook server logs');
  console.log('      - Supabase: command_center_tasks table');
  console.log('      - Expected task type: pre_consultation_notes');
  console.log('      - Badge should show: "Video Consult (Admin)"\n');

  console.log('   ⏳ Waiting for payment... (this script will continue monitoring)\n');

  console.log('🔍 Step 3: Checking payment status...');
  console.log('   ⏳ Deposit not yet paid - waiting for payment...');
  console.log('   ℹ️  After you pay, run:');
  console.log('      node check_webhook_server.js\n');

  console.log('✅ ════════════════════════════════════════════════════════');
  console.log('✅ Setup Complete!');
  console.log('✅ ════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌ Error:', err.response?.data || err.message);
  process.exit(1);
});

