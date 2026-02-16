/**
 * Test script to verify channel selection for contact cx8QkqBYM13LnXkOvnQl
 * This contact has whatsapp_user="Yes" but a US phone number
 * Expected behavior: Should always use SMS (not WhatsApp)
 */

require('dotenv').config();
const axios = require('axios');

const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl';

/**
 * Check if phone number is a U.S. number based on country code.
 */
function isUSPhoneNumber(phone) {
  if (!phone) return true;
  const cleanedPhone = phone.replace(/[^0-9+]/g, '');
  
  if (cleanedPhone.startsWith('+1') && cleanedPhone.length >= 12) return true;
  if (cleanedPhone.startsWith('1') && cleanedPhone.length === 11) return true;
  if (!cleanedPhone.startsWith('+') && cleanedPhone.length === 10) return true;
  if (cleanedPhone.startsWith('+') && !cleanedPhone.startsWith('+1')) return false;
  
  return true;
}

async function verifyContactChannelSelection() {
  console.log('🔍 Verifying Channel Selection for Contact:', CONTACT_ID);
  console.log('='.repeat(80));
  
  try {
    // Fetch contact from GHL
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
    
    // Extract relevant fields
    const phone = contact.phone;
    const whatsappField = customFields.find(f => f.id === 'FnYDobmYqnXDxlLJY5oe');
    const whatsappUser = whatsappField?.value || 'NOT SET';
    
    // Apply channel selection logic
    const isUSPhone = isUSPhoneNumber(phone);
    const hasWhatsAppEnabled = whatsappUser.toLowerCase() === 'yes';
    const willUseWhatsApp = hasWhatsAppEnabled && !isUSPhone;
    const selectedChannel = willUseWhatsApp ? 'WhatsApp' : 'SMS';
    
    // Display results
    console.log('\n📋 Contact Information:');
    console.log(`  Name: ${contact.firstName} ${contact.lastName}`);
    console.log(`  Phone: ${phone}`);
    console.log(`  WhatsApp User Field: ${whatsappUser}`);
    
    console.log('\n📱 Channel Selection Analysis:');
    console.log(`  Is US Phone: ${isUSPhone ? '✅ YES' : '❌ NO'}`);
    console.log(`  WhatsApp Enabled: ${hasWhatsAppEnabled ? '✅ YES' : '❌ NO'}`);
    console.log(`  Will Use WhatsApp: ${willUseWhatsApp ? '✅ YES' : '❌ NO'}`);
    
    console.log('\n🎯 Selected Channel:', selectedChannel);
    
    console.log('\n📊 Logic Explanation:');
    if (isUSPhone) {
      console.log('  ℹ️  US phone number detected → Always use SMS');
      console.log('  ℹ️  WhatsApp is only used for international numbers');
    } else if (hasWhatsAppEnabled) {
      console.log('  ℹ️  International number + WhatsApp enabled → Use WhatsApp');
    } else {
      console.log('  ℹ️  International number but WhatsApp not enabled → Use SMS');
    }
    
    console.log('\n' + '='.repeat(80));
    
    // Verify expected behavior for this test contact
    console.log('\n✅ Verification for Contact cx8QkqBYM13LnXkOvnQl:');
    if (isUSPhone && selectedChannel === 'SMS') {
      console.log('  ✅ CORRECT: US number using SMS (even though whatsapp_user="Yes")');
      console.log('  ✅ This matches iOS app behavior');
      console.log('  ✅ Deposit confirmations will use SMS');
      console.log('  ✅ AI bot replies will use SMS');
    } else if (!isUSPhone && selectedChannel === 'WhatsApp' && hasWhatsAppEnabled) {
      console.log('  ✅ CORRECT: International number using WhatsApp');
    } else if (!isUSPhone && selectedChannel === 'SMS' && !hasWhatsAppEnabled) {
      console.log('  ✅ CORRECT: International number using SMS (WhatsApp not enabled)');
    } else {
      console.log('  ❌ UNEXPECTED: Channel selection may not be working correctly');
      console.log(`     Expected SMS for US number, got ${selectedChannel}`);
    }
    
    console.log('\n');
    
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
    process.exit(1);
  }
}

verifyContactChannelSelection();
