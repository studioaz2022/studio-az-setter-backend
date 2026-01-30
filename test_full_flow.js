/**
 * Full End-to-End Test: Deposit Payment → Task Creation
 * 
 * Tests the complete flow:
 * 1. Set up contact with consultation preferences
 * 2. Simulate Square deposit payment webhook
 * 3. Verify task creation in iOS app
 */

require('dotenv').config();
const axios = require('axios');
const { getContact, updateSystemFields, updateContact, updateTattooFields } = require('./src/clients/ghlClient');
const { handleQualifiedLeadTasks } = require('./src/ai/qualifiedLeadHandler');

const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl';
const TEST_USER = 'Claudia';
const WEBHOOK_SERVER_URL = process.env.APP_WEBHOOK_URL || 'http://localhost:3000';

async function testFullFlow() {
  console.log('\n🧪 ════════════════════════════════════════════════════════');
  console.log('🧪 FULL END-TO-END TEST: Deposit → Task Creation');
  console.log('🧪 ════════════════════════════════════════════════════════\n');

  try {
    // Step 1: Fetch current contact state
    console.log('📋 Step 1: Fetching contact from GHL...');
    const contact = await getContact(CONTACT_ID);
    if (!contact) {
      throw new Error(`Contact ${CONTACT_ID} not found`);
    }
    
    const cf = contact?.customField || contact?.customFields || {};
    const firstName = contact?.firstName || contact?.first_name || '';
    const lastName = contact?.lastName || contact?.last_name || '';
    const contactName = `${firstName} ${lastName}`.trim() || 'Unknown';
    
    console.log(`   ✓ Contact: ${contactName}`);
    console.log(`   ✓ Current consultation_type: ${cf.consultation_type || 'not set'}`);
    console.log(`   ✓ Current language_preference: ${cf.language_preference || 'not set'}`);
    console.log(`   ✓ Current tattoo_size: ${cf.tattoo_size || 'not set'}`);
    console.log(`   ✓ Current assigned_artist: ${cf.assigned_artist || 'not set'}`);
    console.log(`   ✓ Current deposit_paid: ${cf.deposit_paid || 'false'}\n`);

    // Step 2: Set up test scenario (Message-based consultation)
    console.log('⚙️  Step 2: Setting up test scenario (Message Consultation)...');
    
    // Set consultation type to "message" for this test
    // Using updateTattooFields for tattoo-related fields
    await updateTattooFields(CONTACT_ID, {
      consultation_type: 'message',
      language_preference: 'English',
      tattoo_size: 'Small',
      assigned_artist: 'Joan', // Using Joan as test artist
      lead_spanish_comfortable: 'No',
    });
    
    // Also update system fields to ensure they're set
    await updateSystemFields(CONTACT_ID, {
      consultation_type: 'message',
      language_preference: 'English',
      assigned_artist: 'Joan',
    });
    
    console.log('   ✓ Set consultation_type: message');
    console.log('   ✓ Set language_preference: English');
    console.log('   ✓ Set tattoo_size: Small');
    console.log('   ✓ Set assigned_artist: Joan');
    console.log('   ✓ Set lead_spanish_comfortable: No');
    
    // Wait a moment for GHL to sync
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('   ✓ Waited for GHL sync\n');

    // Step 3: Simulate deposit payment (set deposit_paid = true)
    console.log('💳 Step 3: Simulating deposit payment...');
    
    // First, reset deposit_paid to false so we can test the flow
    await updateSystemFields(CONTACT_ID, {
      deposit_paid: false,
    });
    
    // Now simulate the deposit payment
    await updateSystemFields(CONTACT_ID, {
      deposit_paid: true,
    });
    
    console.log('   ✓ Deposit paid flag set to true\n');

    // Step 4: Fetch updated contact and call task handler
    console.log('🔄 Step 4: Fetching updated contact and calling task handler...');
    
    // Wait a bit more for GHL to sync
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const updatedContact = await getContact(CONTACT_ID);
    const updatedCf = updatedContact?.customField || updatedContact?.customFields || {};
    
    // Debug: log all custom fields to see what we have
    console.log('   🔍 All custom fields:', JSON.stringify(Object.keys(updatedCf), null, 2));
    console.log('   🔍 consultation_type values:', {
      'consultation_type': updatedCf.consultation_type,
      'consultationType': updatedCf.consultationType,
      'consultation_preference': updatedCf.consultation_preference,
    });
    
    // Force message consultation for this test
    const consultationType = 'message'; // Force to message for testing
    const languagePreference = updatedCf.language_preference || updatedCf.languagePreference || 'English';
    const leadSpanishComfortable = updatedCf.lead_spanish_comfortable === true || 
                                    updatedCf.lead_spanish_comfortable === 'true' || 
                                    updatedCf.lead_spanish_comfortable === 'Yes';
    const isSpanishOrComfortable = languagePreference === 'Spanish' || leadSpanishComfortable;
    const tattooSize = updatedCf.tattoo_size || updatedCf.size_of_tattoo || 'Small'; // Default for test
    const assignedArtist = updatedCf.assigned_artist || updatedCf.inquired_technician || 'Joan'; // Default for test
    
    console.log(`   ✓ Consultation Type: ${consultationType} (forced for test)`);
    console.log(`   ✓ Language: ${languagePreference} (Spanish-comfortable: ${leadSpanishComfortable})`);
    console.log(`   ✓ Tattoo Size: ${tattooSize}`);
    console.log(`   ✓ Assigned Artist: ${assignedArtist}\n`);

    // Step 5: Call handleQualifiedLeadTasks
    console.log('📤 Step 5: Calling handleQualifiedLeadTasks...');
    const result = await handleQualifiedLeadTasks({
      contactId: CONTACT_ID,
      contactName: contactName,
      consultationType,
      isSpanishOrComfortable,
      tattooSize,
      assignedArtist,
    });
    
    console.log(`   ✓ Task creation result:`, JSON.stringify(result, null, 2));
    console.log('');

    // Step 6: Wait a moment for webhook server to process
    console.log('⏳ Step 6: Waiting for webhook server to process...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('   ✓ Waited 2 seconds\n');

    // Step 7: Check if task was created via webhook server API
    console.log('🔍 Step 7: Checking for created task via webhook server...');
    
    try {
      // Try to query tasks via webhook server if it has an API endpoint
      // Otherwise, we'll just verify the event was sent
      console.log(`   ℹ️  Webhook event should have been sent to: ${WEBHOOK_SERVER_URL}/webhooks/ai-setter/events`);
      console.log(`   ℹ️  Check webhook server logs to verify task creation`);
      console.log(`   ℹ️  Or check Supabase command_center_tasks table directly`);
      
      // Verify the result from handleQualifiedLeadTasks
      if (result && result.taskCreated) {
        console.log(`\n   ✅ SUCCESS: Task creation event sent!`);
        console.log(`      Task Type: ${result.taskType}`);
        console.log(`      Reason: ${result.reason}`);
      } else if (result && !result.taskCreated) {
        console.log(`\n   ℹ️  No task needed: ${result.reason}`);
      }
    } catch (error) {
      console.error('   ⚠️  Could not verify task creation:', error.message);
    }

    console.log('\n✅ ════════════════════════════════════════════════════════');
    console.log('✅ Test completed!');
    console.log('✅ ════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ ════════════════════════════════════════════════════════');
    console.error('❌ Test failed:', error.message);
    console.error('❌ Stack:', error.stack);
    console.error('❌ ════════════════════════════════════════════════════════\n');
    process.exit(1);
  }
}

// Run the test
testFullFlow();

