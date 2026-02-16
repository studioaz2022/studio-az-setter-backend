/**
 * Simulate different FAQ message webhook to trigger AI Bot response
 */

require('dotenv').config();
const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'https://studio-az-setter-backend.onrender.com';
const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl'; // Leonel Chavez
const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const AI_BOT_USER_ID = '3dsbsgZpCWrDYCFPvhKu';

// Simulate a GHL message webhook payload with different FAQ question
const simulatedWebhook = {
  contactId: CONTACT_ID,
  contact: {
    id: CONTACT_ID,
    locationId: GHL_LOCATION_ID,
    firstName: 'Leonel',
    lastName: 'Chavez',
    phone: '+18329390214',
    email: 'leonel@example.com',
  },
  message: 'Where is your studio located?', // Different FAQ question
  type: 'SMS',
  direction: 'inbound',
  phone: '+18329390214',
  locationId: GHL_LOCATION_ID,
};

async function simulateIncomingFAQ() {
  console.log('🧪 SIMULATING DIFFERENT FAQ MESSAGE FROM QUALIFIED LEAD\n');
  console.log('='.repeat(80));
  console.log('Backend URL:', BACKEND_URL);
  console.log('Contact:', simulatedWebhook.contact.firstName, simulatedWebhook.contact.lastName);
  console.log('Message:', simulatedWebhook.message);
  console.log('Expected: AI responds with "-FrontDesk" suffix');
  console.log('='.repeat(80) + '\n');

  try {
    console.log('📤 Sending FAQ webhook to backend...\n');
    
    const webhookResponse = await axios.post(
      `${BACKEND_URL}/ghl/message-webhook`,
      simulatedWebhook,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    console.log('✅ Webhook accepted by backend!\n');
    console.log('Response status:', webhookResponse.status);
    console.log('Response data:', JSON.stringify(webhookResponse.data, null, 2));

    if (webhookResponse.data.debounced) {
      console.log('\n⚠️  Message was debounced (rate-limited)');
      console.log('Wait a bit and try again, or check existing messages');
      return;
    }

    if (webhookResponse.data.skipped) {
      console.log('\n⚠️  AI Bot SKIPPED responding!');
      console.log('Reason:', webhookResponse.data.reason);
      return;
    }

    console.log('\n⏳ Waiting 5 seconds for AI bot to send message to GHL...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('🔍 Checking for AI Bot response in GHL...\n');
    
    const messagesUrl = `https://services.leadconnectorhq.com/conversations/messages/export?locationId=${GHL_LOCATION_ID}&contactId=${CONTACT_ID}&limit=10&sortOrder=desc`;
    
    const messagesResponse = await axios.get(messagesUrl, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-04-15',
        'Accept': 'application/json'
      }
    });

    const messages = messagesResponse.data.messages || [];
    const latestOutbound = messages.find(m => m.direction === 'outbound');

    if (!latestOutbound) {
      console.log('❌ No outbound message found yet');
      return;
    }

    console.log('📬 Latest Outbound Message:\n');
    console.log('Full body:');
    console.log('─'.repeat(80));
    console.log(latestOutbound.body);
    console.log('─'.repeat(80));
    console.log('\nDirection:', latestOutbound.direction);
    console.log('Type:', latestOutbound.messageType);
    console.log('userId:', latestOutbound.userId || 'NOT SET');
    console.log('Date:', new Date(latestOutbound.dateAdded).toLocaleString());
    console.log('Ends with -FrontDesk:', latestOutbound.body?.includes('-FrontDesk') ? '✅ YES' : '❌ NO');

    if (latestOutbound.userId === AI_BOT_USER_ID && latestOutbound.body?.includes('-FrontDesk')) {
      console.log('\n🎉🎉🎉 PERFECT! Everything working correctly! 🎉🎉🎉\n');
      console.log('✅ Message has correct userId:', AI_BOT_USER_ID);
      console.log('✅ Message ends with "-FrontDesk"');
      console.log('✅ iOS app should show "AI Response ✓" checkmark');
    } else if (latestOutbound.userId === AI_BOT_USER_ID) {
      console.log('\n✅ AI Bot message detected (correct userId)');
      console.log('⚠️  But missing "-FrontDesk" suffix');
    } else {
      console.log('\n❌ Not an AI Bot message');
    }

  } catch (err) {
    console.error('\n❌ ERROR:\n');
    if (err.code === 'ECONNABORTED') {
      console.error('Request timeout');
    } else if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    } else {
      console.error('Message:', err.message);
    }
  }
}

console.log('\n🚀 Starting FAQ webhook simulation...\n');
simulateIncomingFAQ();
