/**
 * Simulate incoming message webhook to trigger AI Bot response
 * This will make the AI bot respond with userId: 3dsbsgZpCWrDYCFPvhKu
 */

require('dotenv').config();
const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'https://studio-az-setter-backend.onrender.com';
const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl'; // Leonel Chavez
const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const AI_BOT_USER_ID = '3dsbsgZpCWrDYCFPvhKu';

// Simulate a GHL message webhook payload
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
  message: 'Hey, are you available for a consultation this week?',
  type: 'SMS',
  direction: 'inbound',
  phone: '+18329390214',
  locationId: GHL_LOCATION_ID,
};

async function simulateIncomingMessage() {
  console.log('🧪 SIMULATING INCOMING MESSAGE WEBHOOK\n');
  console.log('='.repeat(80));
  console.log('Backend URL:', BACKEND_URL);
  console.log('Contact:', simulatedWebhook.contact.firstName, simulatedWebhook.contact.lastName);
  console.log('Message:', simulatedWebhook.message);
  console.log('='.repeat(80) + '\n');

  try {
    console.log('📤 Sending webhook to backend...\n');
    
    const webhookResponse = await axios.post(
      `${BACKEND_URL}/ghl/message-webhook`,
      simulatedWebhook,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 second timeout for AI response
      }
    );

    console.log('✅ Webhook accepted by backend!\n');
    console.log('Response status:', webhookResponse.status);
    console.log('Response data:', JSON.stringify(webhookResponse.data, null, 2));

    if (webhookResponse.data.skipped) {
      console.log('\n⏭️  AI Bot SKIPPED responding!');
      console.log('Reason:', webhookResponse.data.reason);
      console.log('\nThis might be because:');
      console.log('- Contact is in a qualified stage (Consult Appointment/Message)');
      console.log('- Message was not detected as an FAQ question');
      console.log('\nTo test AI response, either:');
      console.log('1. Move contact out of qualified stage in GHL');
      console.log('2. Send an FAQ question like "What time is my appointment?"');
      return;
    }

    console.log('\n⏳ Waiting 5 seconds for AI bot to send message to GHL...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Now check if AI bot responded with the userId
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
      console.log('❌ No outbound message found yet. AI might still be processing...');
      console.log('   Wait a few more seconds and run diagnose_ai_messages.js');
      return;
    }

    console.log('📬 Latest Outbound Message:\n');
    console.log('Message preview:', latestOutbound.body?.substring(0, 100) + '...');
    console.log('Direction:', latestOutbound.direction);
    console.log('Type:', latestOutbound.messageType);
    console.log('userId:', latestOutbound.userId || 'NOT SET');
    console.log('Date:', new Date(latestOutbound.dateAdded).toLocaleString());

    if (latestOutbound.userId === AI_BOT_USER_ID) {
      console.log('\n🎉 SUCCESS! AI Bot message detected!\n');
      console.log('✅ Message has correct userId:', AI_BOT_USER_ID);
      console.log('✅ iOS app should show "AI Response ✓" checkmark');
      console.log('\n📱 Next Steps:');
      console.log('1. Open iOS app → Messages → Leonel Chavez');
      console.log('2. Pull to refresh messages');
      console.log('3. Look for "AI Response ✓" above the latest message');
    } else {
      console.log('\n❌ ISSUE: Message does not have AI Bot userId\n');
      console.log('Expected userId:', AI_BOT_USER_ID);
      console.log('Actual userId:', latestOutbound.userId || 'none');
      
      if (latestOutbound.userId && latestOutbound.userId !== AI_BOT_USER_ID) {
        console.log('\n⚠️  Message was sent by a different user (human)');
        console.log('This means the backend code is not being used for this message.');
      } else {
        console.log('\n⚠️  Backend might not be passing userId to GHL API');
        console.log('Check Render logs for errors or issues.');
      }
    }

  } catch (err) {
    console.error('\n❌ ERROR:\n');
    if (err.code === 'ECONNABORTED') {
      console.error('Request timeout - AI is taking too long to respond');
      console.error('Check Render logs for errors');
    } else if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    } else {
      console.error('Message:', err.message);
    }
    console.error('\nTroubleshooting:');
    console.error('1. Check if backend is deployed and running on Render');
    console.error('2. Check Render logs for webhook errors');
    console.error('3. Verify BACKEND_URL is correct:', BACKEND_URL);
  }
}

console.log('\n🚀 Starting webhook simulation...\n');
simulateIncomingMessage();
