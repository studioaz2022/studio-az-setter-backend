/**
 * Fetch the latest AI Bot message and show its full content
 */

require('dotenv').config();
const axios = require('axios');

const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl'; // Leonel Chavez
const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const AI_BOT_USER_ID = '3dsbsgZpCWrDYCFPvhKu';

async function showLatestAIMessage() {
  console.log('🔍 Fetching Latest AI Bot Message\n');

  try {
    const messagesUrl = `https://services.leadconnectorhq.com/conversations/messages/export?locationId=${GHL_LOCATION_ID}&contactId=${CONTACT_ID}&limit=10&sortOrder=desc`;
    
    const messagesResponse = await axios.get(messagesUrl, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-04-15',
        'Accept': 'application/json'
      }
    });

    const messages = messagesResponse.data.messages || [];
    const aiMessages = messages.filter(m => m.direction === 'outbound' && m.userId === AI_BOT_USER_ID);

    if (aiMessages.length === 0) {
      console.log('❌ No AI Bot messages found');
      return;
    }

    console.log(`✅ Found ${aiMessages.length} AI Bot message(s)\n`);
    console.log('='.repeat(80));

    aiMessages.forEach((msg, idx) => {
      console.log(`\nAI Message #${idx + 1}:`);
      console.log('─'.repeat(80));
      console.log('Date:', new Date(msg.dateAdded).toLocaleString());
      console.log('Type:', msg.messageType);
      console.log('─'.repeat(80));
      console.log('\nFull Message Body:\n');
      console.log(msg.body);
      console.log('\n' + '─'.repeat(80));
      console.log('Ends with "-FrontDesk":', msg.body?.includes('-FrontDesk') ? '✅ YES' : '❌ NO');
      console.log('Has double spaces:', msg.body?.endsWith('  ') ? '✅ YES' : '❌ NO (GHL trimmed)');
      console.log('='.repeat(80));
    });

  } catch (err) {
    console.error('\n❌ ERROR:\n');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    } else {
      console.error('Message:', err.message);
    }
  }
}

showLatestAIMessage();
