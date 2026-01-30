/**
 * Check webhook server logs and test connectivity
 */

require('dotenv').config();
const axios = require('axios');

const WEBHOOK_URL = process.env.APP_WEBHOOK_URL || 'http://localhost:3000';
const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl';

async function checkWebhookServer() {
  console.log('\n🔍 ════════════════════════════════════════════════════════');
  console.log('🔍 WEBHOOK SERVER DIAGNOSTICS');
  console.log('🔍 ════════════════════════════════════════════════════════\n');

  try {
    // Step 1: Check health
    console.log(`📡 Step 1: Checking webhook server health...`);
    console.log(`   URL: ${WEBHOOK_URL}/health`);
    
    const healthResponse = await axios.get(`${WEBHOOK_URL}/health`, { timeout: 5000 });
    console.log(`   ✅ Status: ${healthResponse.status}`);
    console.log(`   ✅ Response: ${JSON.stringify(healthResponse.data)}\n`);

    // Step 2: Send a test CREATE_TASK event
    console.log(`📤 Step 2: Sending test CREATE_TASK event...`);
    
    const testEvent = {
      type: 'create_task', // Event type at root level
      contactId: CONTACT_ID, // Contact ID at root level
      timestamp: new Date().toISOString(),
      data: {
        type: 'artist_introduction',
        contactName: 'Test Contact',
        assignedTo: ['1wuLf50VMODExBSJ9xPI'], // Joan
        triggerEvent: 'deposit_paid',
        locationId: 'mUemx2jG4wly4kJWBkI4',
        metadata: {
          consultation_type: 'message',
          tattoo_size: 'Small',
          test: true,
        },
      },
    };
    
    console.log(`   Sending to: ${WEBHOOK_URL}/webhooks/ai-setter/events`);
    console.log(`   Event payload:`, JSON.stringify(testEvent, null, 2));
    
    const eventResponse = await axios.post(
      `${WEBHOOK_URL}/webhooks/ai-setter/events`,
      testEvent,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    
    console.log(`   ✅ Status: ${eventResponse.status}`);
    console.log(`   ✅ Response: ${JSON.stringify(eventResponse.data)}\n`);

    // Step 3: Instructions for checking Supabase
    console.log(`📋 Step 3: Verify in Supabase...`);
    console.log(`   Run this query in Supabase SQL Editor:`);
    console.log(`   
   SELECT 
     id, 
     type, 
     contact_name, 
     assigned_to, 
     status, 
     trigger_event,
     metadata,
     created_at
   FROM command_center_tasks
   WHERE contact_id = '${CONTACT_ID}'
   ORDER BY created_at DESC
   LIMIT 5;
    `);

    console.log('\n✅ ════════════════════════════════════════════════════════');
    console.log('✅ Diagnostics completed!');
    console.log('✅ ════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ ════════════════════════════════════════════════════════');
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
    }
    console.error('❌ ════════════════════════════════════════════════════════\n');
    process.exit(1);
  }
}

checkWebhookServer();

