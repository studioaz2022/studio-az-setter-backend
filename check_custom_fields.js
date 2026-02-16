/**
 * Check contact's custom fields for opportunity_stage_id
 */

require('dotenv').config();
const axios = require('axios');

const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl'; // Leonel Chavez
const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;

async function checkCustomFields() {
  console.log('🔍 Checking Contact Custom Fields\n');

  try {
    const contactUrl = `https://services.leadconnectorhq.com/contacts/${CONTACT_ID}`;
    const contactResp = await axios.get(contactUrl, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });

    const contact = contactResp.data.contact;
    
    console.log('📇 Contact Info:\n');
    console.log('Name:', contact.firstName, contact.lastName);
    
    console.log('\n📋 Custom Fields:\n');
    
    const cf = contact?.customField || contact?.customFields || {};
    
    console.log('Raw customField object:', JSON.stringify(cf, null, 2));
    
    console.log('\nChecking for opportunity_stage_id...');
    const stageId = cf.opportunity_stage_id || cf.opportunityStageId || cf.OpportunityStageId;
    console.log('opportunity_stage_id:', stageId || 'NOT FOUND');
    
    if (!stageId) {
      console.log('\n❌ No opportunity_stage_id found in custom fields!');
      console.log('⚠️  isInQualifiedStage() will return FALSE');
      console.log('🤖 AI Bot will respond to ALL messages (no qualified lead limiting)');
    }

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

checkCustomFields();
