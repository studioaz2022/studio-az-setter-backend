/**
 * Manually set consultation_type for test contact
 */

require('dotenv').config();
const axios = require('axios');

const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl';
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'mUemx2jG4wly4kJWBkI4';

async function setConsultationType() {
  console.log('\n🔧 Setting consultation_type for test contact...\n');
  
  try {
    // First, get the contact to see current state
    console.log('📋 Step 1: Fetching current contact state...');
    const getResponse = await axios.get(
      `https://rest.gohighlevel.com/v1/contacts/${CONTACT_ID}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
        },
      }
    );
    
    const contact = getResponse.data.contact;
    const cf = contact?.customField || {};
    
    console.log(`   Contact: ${contact.firstName} ${contact.lastName}`);
    console.log(`   Current consultation_type: ${cf.consultation_type || 'not set'}`);
    console.log(`   Current assigned_artist: ${cf.assigned_artist || 'not set'}`);
    console.log('');
    
    // Update the contact with consultation_type = "message"
    // Using the correct GHL field ID: gM2PVo90yNBDHekV5G64
    console.log('📝 Step 2: Updating consultation_type to "message"...');
    const updateResponse = await axios.put(
      `https://rest.gohighlevel.com/v1/contacts/${CONTACT_ID}`,
      {
        customField: {
          gM2PVo90yNBDHekV5G64: 'message', // consultation_type field ID
          assigned_artist: 'Joan',
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
      }
    );
    
    console.log(`   ✅ Update successful (status: ${updateResponse.status})`);
    console.log('');
    
    // Wait for GHL to sync
    console.log('⏳ Step 3: Waiting for GHL to sync (3 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('');
    
    // Verify the update
    console.log('🔍 Step 4: Verifying update...');
    const verifyResponse = await axios.get(
      `https://rest.gohighlevel.com/v1/contacts/${CONTACT_ID}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
        },
      }
    );
    
    const updatedContact = verifyResponse.data.contact;
    const updatedCf = updatedContact?.customField || {};
    
    // Check by field ID (gM2PVo90yNBDHekV5G64) and field name
    console.log(`   consultation_type (by name): ${updatedCf.consultation_type || 'NOT SET ❌'}`);
    console.log(`   consultation_type (by ID): ${updatedCf.gM2PVo90yNBDHekV5G64 || 'NOT SET ❌'}`);
    console.log(`   assigned_artist: ${updatedCf.assigned_artist || 'NOT SET ❌'}`);
    console.log(`   All custom field keys: ${Object.keys(updatedCf).join(', ')}`);
    console.log('');
    
    if (updatedCf.consultation_type === 'message') {
      console.log('✅ ════════════════════════════════════════════════════════');
      console.log('✅ SUCCESS: consultation_type set to "message"');
      console.log('✅ ════════════════════════════════════════════════════════\n');
      console.log('📋 Next steps:');
      console.log('   1. Pay the Square link again (or create a new one)');
      console.log('   2. Check Render logs - should now show:');
      console.log('      Consultation Type: message');
      console.log('      ✅ Task creation event sent: artist_introduction');
      console.log('   3. Check Supabase for the created task');
      console.log('   4. Check iOS app Command Center\n');
    } else {
      console.log('⚠️  ════════════════════════════════════════════════════════');
      console.log('⚠️  WARNING: consultation_type may not have persisted');
      console.log('⚠️  ════════════════════════════════════════════════════════\n');
      console.log('This might be due to:');
      console.log('  - GHL eventual consistency (try again in a few seconds)');
      console.log('  - Field key mismatch');
      console.log('  - API permissions\n');
    }
    
  } catch (error) {
    console.error('\n❌ ════════════════════════════════════════════════════════');
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    }
    console.error('❌ ════════════════════════════════════════════════════════\n');
    process.exit(1);
  }
}

setConsultationType();

