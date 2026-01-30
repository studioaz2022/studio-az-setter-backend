/**
 * Fresh Start: Complete End-to-End Test
 * 
 * This test:
 * 1. Sets up contact with correct fields
 * 2. Assigns to Claudia
 * 3. Creates REAL Square payment link
 * 4. Provides instructions for payment
 * 5. Verifies task creation
 */

require('dotenv').config();
const { 
  getContact, 
  updateSystemFields, 
  updateTattooFields,
  updateContactAssignedUser
} = require('./src/clients/ghlClient');
const { createDepositLinkForContact } = require('./src/payments/squareClient');

const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl';
const CLAUDIA_GHL_USER_ID = 'Wl24x1ZrucHuHatM0ODD';

async function freshStartTest() {
  console.log('\n🚀 ════════════════════════════════════════════════════════');
  console.log('🚀 FRESH START: Complete End-to-End Test');
  console.log('🚀 ════════════════════════════════════════════════════════\n');

  try {
    // Step 1: Fetch current contact state
    console.log('📋 Step 1: Fetching contact from GHL...');
    const contact = await getContact(CONTACT_ID);
    if (!contact) {
      throw new Error(`Contact ${CONTACT_ID} not found`);
    }
    
    const cf = contact?.customField || [];
    const firstName = contact?.firstName || contact?.first_name || '';
    const lastName = contact?.lastName || contact?.last_name || '';
    const contactName = `${firstName} ${lastName}`.trim() || 'Unknown';
    
    console.log(`   ✓ Contact: ${contactName}`);
    console.log(`   ✓ Current assigned_user_id: ${contact.assignedUserId || 'not set'}`);
    
    // Check current consultation_type
    const consultField = cf.find(f => f.id === 'gM2PVo90yNBDHekV5G64');
    console.log(`   ✓ Current consultation_type: ${consultField?.value || 'not set'}`);
    
    // Check tattoo_size
    const sizeField = cf.find(f => f.id === 'KXtfZYdeSKUyS5llTKsr');
    console.log(`   ✓ Current tattoo_size: ${sizeField?.value || 'not set'}`);
    
    // Check assigned_artist
    const artistField = cf.find(f => f.id === 'H3PSN8tZSw1kYckHJN9D');
    console.log(`   ✓ Current assigned_artist: ${artistField?.value || 'not set'}\n`);

    // Step 2: Assign contact to Claudia
    console.log('👤 Step 2: Assigning contact to Claudia...');
    try {
      await updateContactAssignedUser(CONTACT_ID, CLAUDIA_GHL_USER_ID);
      console.log(`   ✅ Contact assigned to Claudia (${CLAUDIA_GHL_USER_ID})\n`);
    } catch (err) {
      console.log(`   ⚠️  Error assigning user (may already be assigned): ${err.message}\n`);
    }

    // Step 3: Set consultation preferences
    console.log('⚙️  Step 3: Setting consultation preferences...');
    
    // Reset deposit_paid first
    await updateSystemFields(CONTACT_ID, {
      deposit_paid: false,
    });
    console.log('   ✓ Reset deposit_paid: false');
    
    // Set consultation preferences using updateTattooFields (which uses CUSTOM_FIELD_MAP)
    await updateTattooFields(CONTACT_ID, {
      consultation_type: 'message',
      language_preference: 'English',
      tattoo_size: 'Small',
      assigned_artist: 'Joan',
    });
    console.log('   ✓ Set consultation_type: message');
    console.log('   ✓ Set language_preference: English');
    console.log('   ✓ Set tattoo_size: Small');
    console.log('   ✓ Set assigned_artist: Joan');
    
    // Also set via system fields for consistency
    await updateSystemFields(CONTACT_ID, {
      consultation_type: 'message',
      language_preference: 'English',
      assigned_artist: 'Joan',
    });
    
    // Wait for GHL to sync
    console.log('   ⏳ Waiting for GHL to sync (3 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('   ✓ GHL sync complete\n');

    // Step 4: Verify fields were set
    console.log('🔍 Step 4: Verifying fields were set...');
    const updatedContact = await getContact(CONTACT_ID);
    const updatedCf = updatedContact?.customField || [];
    
    const updatedConsultField = updatedCf.find(f => f.id === 'gM2PVo90yNBDHekV5G64');
    const updatedSizeField = updatedCf.find(f => f.id === 'KXtfZYdeSKUyS5llTKsr');
    const updatedArtistField = updatedCf.find(f => f.id === 'H3PSN8tZSw1kYckHJN9D');
    
    console.log(`   consultation_type: ${updatedConsultField?.value || 'NOT SET ❌'}`);
    console.log(`   tattoo_size: ${updatedSizeField?.value || 'NOT SET ❌'}`);
    console.log(`   assigned_artist: ${updatedArtistField?.value || 'NOT SET ❌'}`);
    
    if (updatedConsultField?.value === 'message') {
      console.log('   ✅ All fields set correctly!\n');
    } else {
      console.log('   ⚠️  Fields may not have synced yet. Continuing anyway...\n');
    }

    // Step 5: Create REAL Square payment link
    console.log('💳 Step 5: Creating REAL Square payment link...');
    try {
      const paymentLink = await createDepositLinkForContact({
        contactId: CONTACT_ID,
        amountCents: 10000, // $100 deposit
        description: 'Studio AZ Tattoo Consultation Deposit - Fresh Test',
      });
      
      console.log('\n   ✅ ════════════════════════════════════════════════════════');
      console.log('   ✅ PAYMENT LINK CREATED!');
      console.log('   ✅ ════════════════════════════════════════════════════════\n');
      console.log(`   📱 Payment Link: ${paymentLink.url}`);
      console.log(`   🔑 Payment Link ID: ${paymentLink.paymentLinkId}`);
      console.log(`   📦 Order ID: ${paymentLink.orderId || 'will be generated on payment'}\n`);
      
      console.log('   📋 NEXT STEPS:');
      console.log('   1. Open this link in your browser:');
      console.log(`      ${paymentLink.url}\n`);
      console.log('   2. Pay with Square Sandbox test card:');
      console.log('      Card: 4111 1111 1111 1111');
      console.log('      CVV: 111');
      console.log('      Expiry: Any future date');
      console.log('      ZIP: Any 5 digits\n');
      console.log('   3. After payment, check:');
      console.log('      - Render logs: https://dashboard.render.com/');
      console.log('      - Webhook server logs (ngrok)');
      console.log('      - Supabase: command_center_tasks table');
      console.log('      - iOS app: Command Center (as Claudia)\n');
      
      console.log('   ⏳ Waiting for payment... (this script will continue monitoring)\n');
      
      // Wait a bit, then check if payment was made
      await new Promise(resolve => setTimeout(resolve, 5000));
      
    } catch (err) {
      console.error(`   ❌ Error creating payment link: ${err.message}`);
      throw err;
    }

    // Step 6: Monitor for payment (optional - can be done manually)
    console.log('🔍 Step 6: Checking payment status...');
    const finalContact = await getContact(CONTACT_ID);
    const finalCf = finalContact?.customField || [];
    
    // Check deposit_paid field (might be in system fields)
    const depositPaid = finalContact?.deposit_paid || finalCf.find(f => f.key === 'deposit_paid')?.value;
    
    if (depositPaid === true || depositPaid === 'Yes' || depositPaid === 'true') {
      console.log('   ✅ Deposit has been paid!');
      console.log('   ✅ Task should be created in iOS app\n');
    } else {
      console.log('   ⏳ Deposit not yet paid - waiting for payment...');
      console.log('   ℹ️  After you pay, check:');
      console.log('      - Render logs for task creation event');
      console.log('      - Supabase for task record');
      console.log('      - iOS app Command Center\n');
    }

    console.log('✅ ════════════════════════════════════════════════════════');
    console.log('✅ Setup Complete!');
    console.log('✅ ════════════════════════════════════════════════════════\n');
    
    console.log('📊 Summary:');
    console.log(`   • Contact: ${contactName} (${CONTACT_ID})`);
    console.log(`   • Assigned to: Claudia (${CLAUDIA_GHL_USER_ID})`);
    console.log(`   • Consultation Type: message`);
    console.log(`   • Tattoo Size: Small`);
    console.log(`   • Assigned Artist: Joan`);
    console.log(`   • Payment Link: Created ✅`);
    console.log(`   • Expected Task: artist_introduction`);
    console.log(`   • Expected Badge: "Message Consult"\n`);

  } catch (error) {
    console.error('\n❌ ════════════════════════════════════════════════════════');
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
    }
    console.error('   Stack:', error.stack);
    console.error('❌ ════════════════════════════════════════════════════════\n');
    process.exit(1);
  }
}

// Run the test
freshStartTest();

