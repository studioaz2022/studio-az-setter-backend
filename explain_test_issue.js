require('dotenv').config();
const axios = require('axios');

const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl';

async function checkContactStatus() {
  const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
  
  const response = await axios.get(
    `https://services.leadconnectorhq.com/contacts/${CONTACT_ID}`,
    {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28'
      }
    }
  );
  
  const contact = response.data.contact;
  const customFields = contact.customFields || [];
  
  console.log('📋 Contact Information:\n');
  console.log('Name:', contact.firstName, contact.lastName);
  console.log('Phone:', contact.phone);
  
  // Check stage
  const stageIdField = customFields.find(f => f.id.includes('stage') || f.key?.includes('stage'));
  console.log('Stage:', stageIdField?.value || 'Not set');
  
  console.log('\n💡 KEY INSIGHT:');
  console.log('All recent messages have userId: Wl24x1ZrucHuHatM0ODD');
  console.log('This is YOUR user ID - messages you sent from iOS app!');
  console.log('\n🤔 THE ISSUE:');
  console.log('The AI Bot has NOT responded yet after deployment.');
  console.log('That\'s why there are no messages with AI Bot userId (3dsbsgZpCWrDYCFPvhKu)');
  
  console.log('\n📱 TO TEST PROPERLY:');
  console.log('1. Send a message FROM YOUR PHONE (actual SMS)');
  console.log('   Phone: ' + contact.phone);
  console.log('   Send to: Studio AZ number');
  console.log('   Message: "Hey, are you available this week?"');
  console.log('');
  console.log('2. This will trigger webhook → AI Bot responds');
  console.log('3. AI response will have userId: 3dsbsgZpCWrDYCFPvhKu');
  console.log('4. Then check iOS app for "AI Response ✓" checkmark');
  console.log('');
  console.log('⚠️  Messages sent FROM the iOS app (by you) are not AI messages!');
}

checkContactStatus().catch(err => console.error('Error:', err.message));
