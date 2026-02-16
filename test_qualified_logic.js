/**
 * Test the qualified stage detection logic
 */

require('dotenv').config();
const axios = require('axios');

const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl'; // Leonel Chavez
const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

const QUALIFIED_STAGE_IDS = [
  'd30d3a30-3a78-4123-9387-8db3d6dd8a20', // Consult Appointment (video scheduled)
  '09587a76-13ae-41b3-bd57-81da11f1c56c'  // Consult Message (artist handling)
];

async function isInQualifiedStage(contactId, locationId) {
  try {
    const opportunitiesUrl = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&contact_id=${contactId}`;
    const oppsResp = await axios.get(opportunitiesUrl, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });

    const opportunities = oppsResp.data.opportunities || [];
    
    console.log(`📊 Found ${opportunities.length} opportunities:`);
    opportunities.forEach((opp, idx) => {
      console.log(`\n  Opportunity ${idx + 1}:`);
      console.log(`    Name: ${opp.name}`);
      console.log(`    Stage ID: ${opp.pipelineStageId}`);
      console.log(`    Status: ${opp.status}`);
      console.log(`    Is Qualified: ${QUALIFIED_STAGE_IDS.includes(opp.pipelineStageId) ? '✅ YES' : '❌ NO'}`);
      console.log(`    Is Open: ${opp.status === 'open' ? '✅ YES' : '❌ NO'}`);
    });
    
    // Check if contact has any open opportunity in a qualified stage
    const hasQualifiedOpp = opportunities.some(opp => 
      QUALIFIED_STAGE_IDS.includes(opp.pipelineStageId) && opp.status === 'open'
    );

    return hasQualifiedOpp;
  } catch (err) {
    console.error("⚠️ Error checking qualified stage:", err.message);
    return false; // Default to not qualified if error
  }
}

function detectFAQQuestion(text) {
  if (!text) return false;
  
  const lower = text.toLowerCase();
  
  // Common FAQ patterns for tattoo studio
  const faqPatterns = [
    // Time/scheduling questions
    /what\s+time/i,
    /when\s+(is|are)/i,
    /appointment\s+time/i,
    
    // Location questions
    /where\s+(is|are|do)/i,
    /address/i,
    /location/i,
    /how\s+do\s+i\s+get/i,
    /directions/i,
    
    // Preparation questions
    /what\s+should\s+i\s+bring/i,
    /how\s+(to|do\s+i)\s+prepare/i,
    /before\s+(my|the)\s+appointment/i,
    /what\s+to\s+(expect|wear)/i,
    
    // Logistics
    /parking/i,
    /how\s+long/i,
    /duration/i,
    /how\s+much\s+time/i,
    
    // Rescheduling
    /reschedule/i,
    /cancel/i,
    /change\s+(my\s+)?appointment/i,
    /move\s+(my\s+)?appointment/i,
    
    // Payment/cost
    /how\s+much/i,
    /cost/i,
    /price/i,
    /payment/i,
    /pay/i,
    
    // Aftercare (pre-appointment questions about post-care)
    /aftercare/i,
    /how\s+to\s+care/i,
    /healing/i,
  ];
  
  return faqPatterns.some(pattern => pattern.test(lower));
}

async function shouldAIRespond(contactId, locationId, messageText) {
  // Check if lead is in qualified stage
  const isQualified = await isInQualifiedStage(contactId, locationId);
  
  if (!isQualified) {
    return { 
      shouldRespond: true, 
      reason: 'lead_not_qualified',
      appendFrontDesk: false
    };
  }
  
  // Lead is qualified - only respond to FAQ questions
  const isFAQ = detectFAQQuestion(messageText);
  
  if (isFAQ) {
    return { 
      shouldRespond: true, 
      reason: 'qualified_faq_question',
      appendFrontDesk: true  // Add -FrontDesk suffix
    };
  }
  
  // Qualified lead, not FAQ - artist should handle
  return { 
    shouldRespond: false, 
    reason: 'qualified_artist_handles',
    appendFrontDesk: false
  };
}

async function testLogic() {
  console.log('🧪 Testing Qualified Stage Detection Logic\n');
  console.log('='.repeat(80));
  console.log('Contact:', CONTACT_ID);
  console.log('Location:', GHL_LOCATION_ID);
  console.log('='.repeat(80) + '\n');

  const testMessage = 'What time is my appointment?';
  
  console.log(`📝 Test Message: "${testMessage}"\n`);
  
  const isFAQ = detectFAQQuestion(testMessage);
  console.log(`🔍 FAQ Detection: ${isFAQ ? '✅ IS FAQ' : '❌ NOT FAQ'}\n`);
  
  const result = await shouldAIRespond(CONTACT_ID, GHL_LOCATION_ID, testMessage);
  
  console.log('\n' + '='.repeat(80));
  console.log('📊 FINAL RESULT:');
  console.log('='.repeat(80));
  console.log('Should AI Respond:', result.shouldRespond ? '✅ YES' : '❌ NO');
  console.log('Reason:', result.reason);
  console.log('Append -FrontDesk:', result.appendFrontDesk ? '✅ YES' : '❌ NO');
  console.log('='.repeat(80));
}

testLogic();
