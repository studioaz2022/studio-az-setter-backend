/**
 * Diagnostic script to check if AI Bot userId is present in messages
 */

require('dotenv').config();
const axios = require('axios');

const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl'; // Leonel Chavez
const AI_BOT_USER_ID = '3dsbsgZpCWrDYCFPvhKu';

async function checkMessages() {
  console.log('🔍 Checking Messages for AI Bot userId\n');
  console.log('='.repeat(80));
  console.log(`Contact: ${CONTACT_ID} (Leonel Chavez)`);
  console.log(`Expected AI Bot userId: ${AI_BOT_USER_ID}`);
  console.log('='.repeat(80) + '\n');

  try {
    // Fetch recent messages
    const url = `https://services.leadconnectorhq.com/conversations/messages/export?locationId=${GHL_LOCATION_ID}&contactId=${CONTACT_ID}&limit=10&sortOrder=desc`;
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-04-15',
        'Accept': 'application/json'
      }
    });

    const messages = response.data.messages || [];
    
    console.log(`📬 Found ${messages.length} recent messages\n`);

    // Analyze last 5 outbound messages
    const outboundMessages = messages
      .filter(m => m.direction === 'outbound')
      .slice(0, 5);

    if (outboundMessages.length === 0) {
      console.log('⚠️  No outbound messages found. Send a test message first!\n');
      return;
    }

    console.log('📊 OUTBOUND MESSAGES ANALYSIS:\n');

    outboundMessages.forEach((msg, idx) => {
      const msgNumber = outboundMessages.length - idx;
      const body = msg.body || '(no body)';
      const preview = body.substring(0, 60) + (body.length > 60 ? '...' : '');
      const userId = msg.userId || null;
      const hasAIUserId = userId === AI_BOT_USER_ID;
      const hasDoubleSpace = body.endsWith('  ');
      
      console.log(`Message ${msgNumber}:`);
      console.log(`  Preview: "${preview}"`);
      console.log(`  Direction: ${msg.direction}`);
      console.log(`  Type: ${msg.type}`);
      console.log(`  Message Type: ${msg.messageType || 'N/A'}`);
      console.log(`  userId: ${userId || 'NOT SET'} ${hasAIUserId ? '✅ MATCHES AI BOT' : '❌ DOES NOT MATCH'}`);
      console.log(`  Has double-space marker: ${hasDoubleSpace ? '✅ YES' : '❌ NO (trimmed)'}`);
      console.log(`  Date: ${new Date(msg.dateAdded).toLocaleString()}`);
      console.log(`  Raw userId field present: ${msg.hasOwnProperty('userId') ? 'YES' : 'NO'}`);
      
      if (hasAIUserId) {
        console.log(`  🎯 THIS IS AN AI MESSAGE - Should show checkmark in iOS app!`);
      } else if (userId && userId !== AI_BOT_USER_ID) {
        console.log(`  👤 Human message from user: ${userId}`);
      } else {
        console.log(`  ⚠️  No userId set - iOS app won't detect as AI`);
      }
      
      console.log('');
    });

    // Summary
    console.log('='.repeat(80));
    console.log('\n📋 SUMMARY:\n');
    
    const aiMessages = outboundMessages.filter(m => m.userId === AI_BOT_USER_ID);
    const messagesWithoutUserId = outboundMessages.filter(m => !m.userId);
    
    console.log(`Total outbound messages checked: ${outboundMessages.length}`);
    console.log(`Messages with AI Bot userId: ${aiMessages.length} ${aiMessages.length > 0 ? '✅' : '❌'}`);
    console.log(`Messages without userId: ${messagesWithoutUserId.length} ${messagesWithoutUserId.length > 0 ? '⚠️' : ''}`);
    
    if (aiMessages.length > 0) {
      console.log('\n✅ GOOD: Messages have AI Bot userId set!');
      console.log('   iOS app should detect these as AI responses.');
      console.log('   If checkmark not showing, issue is in iOS app detection logic.');
    } else if (messagesWithoutUserId.length > 0) {
      console.log('\n❌ ISSUE: Messages sent without userId field!');
      console.log('   Backend may not be deployed yet, or userId not being sent to GHL.');
      console.log('   iOS app cannot detect AI responses without userId.');
    }
    
    console.log('\n');

  } catch (err) {
    console.error('❌ Error fetching messages:');
    console.error('Status:', err.response?.status);
    console.error('Error:', err.response?.data || err.message);
  }
}

checkMessages();
