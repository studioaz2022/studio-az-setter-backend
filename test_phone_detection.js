/**
 * Test script to verify US phone number detection logic
 * This ensures the backend matches the iOS app's behavior
 */

/**
 * Check if phone number is a U.S. number based on country code.
 * U.S. numbers start with +1 followed by a 3-digit area code.
 * This matches the logic in the iOS app's Conversation.swift model.
 */
function isUSPhoneNumber(phone) {
  if (!phone) return true; // Default to US if no phone
  
  // Remove all non-digit characters except leading +
  const cleanedPhone = phone.replace(/[^0-9+]/g, '');
  
  // Check for +1 country code (US/Canada)
  if (cleanedPhone.startsWith('+1') && cleanedPhone.length >= 12) {
    return true;
  }
  
  // Check for 1 followed by 10 digits (US format without +)
  if (cleanedPhone.startsWith('1') && cleanedPhone.length === 11) {
    return true;
  }
  
  // Check for 10-digit number (US format without country code)
  if (!cleanedPhone.startsWith('+') && cleanedPhone.length === 10) {
    return true;
  }
  
  // If it starts with a different country code, it's international
  if (cleanedPhone.startsWith('+') && !cleanedPhone.startsWith('+1')) {
    return false;
  }
  
  // Default to US if we can't determine
  return true;
}

// Test cases
const testCases = [
  { phone: '+16125551234', expected: true, description: 'US number with +1 prefix' },
  { phone: '16125551234', expected: true, description: 'US number with 1 prefix (no +)' },
  { phone: '6125551234', expected: true, description: 'US number without prefix (10 digits)' },
  { phone: '+1 (612) 555-1234', expected: true, description: 'US number with formatting' },
  { phone: '(612) 555-1234', expected: true, description: 'US number with formatting (no country code)' },
  { phone: '+52 55 1234 5678', expected: false, description: 'Mexico number (+52)' },
  { phone: '+44 20 7946 0958', expected: false, description: 'UK number (+44)' },
  { phone: '+91 98765 43210', expected: false, description: 'India number (+91)' },
  { phone: '+49 30 12345678', expected: false, description: 'Germany number (+49)' },
  { phone: '', expected: true, description: 'Empty phone (default to US)' },
  { phone: null, expected: true, description: 'Null phone (default to US)' },
  { phone: undefined, expected: true, description: 'Undefined phone (default to US)' },
];

console.log('🧪 Testing US Phone Number Detection\n');
console.log('=' .repeat(80));

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  const result = isUSPhoneNumber(test.phone);
  const status = result === test.expected ? '✅ PASS' : '❌ FAIL';
  
  if (result === test.expected) {
    passed++;
  } else {
    failed++;
  }
  
  console.log(`\nTest ${index + 1}: ${test.description}`);
  console.log(`  Phone: ${test.phone || '(empty)'}`);
  console.log(`  Expected: ${test.expected ? 'US' : 'International'}`);
  console.log(`  Result: ${result ? 'US' : 'International'}`);
  console.log(`  ${status}`);
});

console.log('\n' + '='.repeat(80));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${testCases.length} tests\n`);

if (failed === 0) {
  console.log('✅ All tests passed! Phone detection logic is working correctly.');
} else {
  console.log('❌ Some tests failed. Please review the logic.');
  process.exit(1);
}

// Test WhatsApp channel selection logic
console.log('\n' + '='.repeat(80));
console.log('\n🧪 Testing WhatsApp Channel Selection Logic\n');
console.log('Rule: Use WhatsApp ONLY if whatsapp_user="Yes" AND phone is international\n');

const channelTests = [
  { phone: '+16125551234', whatsappUser: 'Yes', expectedChannel: 'SMS', reason: 'US phone - always SMS' },
  { phone: '+16125551234', whatsappUser: 'No', expectedChannel: 'SMS', reason: 'US phone - always SMS' },
  { phone: '+52 55 1234 5678', whatsappUser: 'Yes', expectedChannel: 'WhatsApp', reason: 'International + WhatsApp enabled' },
  { phone: '+52 55 1234 5678', whatsappUser: 'No', expectedChannel: 'SMS', reason: 'International but WhatsApp not enabled' },
  { phone: '6125551234', whatsappUser: 'Yes', expectedChannel: 'SMS', reason: 'US phone - always SMS' },
  { phone: '+44 20 7946 0958', whatsappUser: 'Yes', expectedChannel: 'WhatsApp', reason: 'UK number + WhatsApp enabled' },
];

channelTests.forEach((test, index) => {
  const isUS = isUSPhoneNumber(test.phone);
  const hasWhatsApp = test.whatsappUser.toLowerCase() === 'yes';
  const useWhatsApp = hasWhatsApp && !isUS;
  const channel = useWhatsApp ? 'WhatsApp' : 'SMS';
  const status = channel === test.expectedChannel ? '✅ PASS' : '❌ FAIL';
  
  console.log(`\nChannel Test ${index + 1}:`);
  console.log(`  Phone: ${test.phone}`);
  console.log(`  WhatsApp User: ${test.whatsappUser}`);
  console.log(`  Is US Phone: ${isUS}`);
  console.log(`  Expected: ${test.expectedChannel}`);
  console.log(`  Result: ${channel}`);
  console.log(`  Reason: ${test.reason}`);
  console.log(`  ${status}`);
});

console.log('\n' + '='.repeat(80) + '\n');
