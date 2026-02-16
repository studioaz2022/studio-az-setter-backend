const axios = require('axios');
require('dotenv').config();

const GHL_API_KEY = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const CONTACT_ID = 'cx8QkqBYM13LnXkOvnQl';

async function checkContact() {
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
  
  console.log('📋 Contact Custom Fields:\n');
  
  // Find whatsapp_user field
  const whatsappField = customFields.find(f => f.id === 'FnYDobmYqnXDxlLJY5oe');
  
  console.log('WhatsApp User Field (FnYDobmYqnXDxlLJY5oe):');
  console.log('  Value:', whatsappField?.value || 'NOT SET');
  console.log('');
  
  console.log('📱 Phone:', contact.phone);
  console.log('');
  
  console.log('💡 If whatsapp_user = "Yes", system will send WhatsApp');
  console.log('💡 If whatsapp_user = "No", system will send SMS');
}

checkContact().catch(err => {
  console.error('Error:', err.response?.data || err.message);
});
