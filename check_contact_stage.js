/**
 * Check contact's opportunity stage to see if they're in a qualified stage
 */

require('dotenv').config();
const axios = require('axios');

const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl'; // Leonel Chavez
const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;

const QUALIFIED_STAGE_IDS = [
  'd30d3a30-3a78-4123-9387-8db3d6dd8a20', // Consult Appointment (video scheduled)
  '09587a76-13ae-41b3-bd57-81da11f1c56c'  // Consult Message (artist handling)
];

async function checkContactStage() {
  console.log('🔍 Checking Contact Opportunity Stage\n');
  console.log('='.repeat(80));
  console.log('Contact:', CONTACT_ID);
  console.log('='.repeat(80) + '\n');

  try {
    // Fetch contact from GHL
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
    console.log('Phone:', contact.phone);
    console.log('Email:', contact.email);
    console.log('Assigned To:', contact.assignedTo || 'UNASSIGNED');
    
    // Check for opportunities
    const opportunitiesUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${contact.locationId}&contact_id=${CONTACT_ID}`;
    const oppsResp = await axios.get(opportunitiesUrl, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });

    const opportunities = oppsResp.data.opportunities || [];
    
    console.log('\n💼 Opportunities:\n');
    
    if (opportunities.length === 0) {
      console.log('❌ No opportunities found');
      console.log('\n✅ Contact is NOT in a qualified stage');
      console.log('🤖 AI Bot SHOULD respond to messages');
      return;
    }

    opportunities.forEach((opp, idx) => {
      console.log(`Opportunity ${idx + 1}:`);
      console.log('  Name:', opp.name);
      console.log('  Pipeline:', opp.pipelineName);
      console.log('  Stage:', opp.pipelineStageName);
      console.log('  Stage ID:', opp.pipelineStageId);
      console.log('  Status:', opp.status);
      
      const isQualified = QUALIFIED_STAGE_IDS.includes(opp.pipelineStageId);
      console.log('  Is Qualified Stage:', isQualified ? '✅ YES' : '❌ NO');
      console.log('');
    });

    const hasQualifiedOpp = opportunities.some(opp => 
      QUALIFIED_STAGE_IDS.includes(opp.pipelineStageId) && opp.status === 'open'
    );

    console.log('='.repeat(80));
    if (hasQualifiedOpp) {
      console.log('\n⚠️  CONTACT IS IN A QUALIFIED STAGE\n');
      console.log('🤖 AI Bot will ONLY respond to FAQ questions');
      console.log('📝 Responses will end with "-FrontDesk"');
      console.log('\nTo get AI to respond, either:');
      console.log('1. Move contact to a different pipeline stage');
      console.log('2. Send an FAQ question like:');
      console.log('   - "What time is my appointment?"');
      console.log('   - "How much does a small tattoo cost?"');
      console.log('   - "Do I need to pay a deposit?"');
    } else {
      console.log('\n✅ CONTACT IS NOT IN A QUALIFIED STAGE\n');
      console.log('🤖 AI Bot SHOULD respond to all messages');
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

console.log('\n🚀 Starting stage check...\n');
checkContactStage();
