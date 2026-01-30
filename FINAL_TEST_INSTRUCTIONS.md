# Final Test: Square Payment → Task Creation

## ✅ Fix Applied

Added `consultation_type` field ID to `CUSTOM_FIELD_MAP` in `ghlClient.js`:
```javascript
consultation_type: "gM2PVo90yNBDHekV5G64"
```

This allows the backend to properly read and write the `consultation_type` field.

## Current Status

- ✅ Code deployed to GitHub (commit: d2dac4b)
- ⏳ Waiting for Render to deploy (~2-3 minutes)
- ✅ Test contact fields set correctly:
  - `consultation_type` = `message`
  - `tattoo_size` = `Small`
  - `language_preference` = `English`

## Test Instructions

### 1. Wait for Render Deployment

Check: https://dashboard.render.com/
- Look for your backend service
- Wait for "Deploy succeeded" message

### 2. Create New Square Payment Link

Run:
```bash
cd /Users/studioaz/AZ\ Setter\ Cursor/studio-az-setter-backend
node test_realistic_flow.js
```

This will:
- Assign contact to Claudia
- Set consultation preferences
- Create a real Square payment link
- Output the link URL

### 3. Pay the Square Link

- Use the Square Sandbox test card:
  - Card: `4111 1111 1111 1111`
  - CVV: `111`
  - Expiry: Any future date
  - ZIP: Any 5 digits

### 4. Check Render Logs

Should now show:
```
💳 Deposit paid for contact: cx8QkqBYM13LnXkOvnQl
📋 Processing qualified lead task for: Leonel Chavez
   Consultation Type: message  ✅
   Spanish/Comfortable: false
   Tattoo Size: Small  ✅
   Assigned Artist: Joan  ✅
   Current Route: A
📱 App event sent: create_task for contact cx8QkqBYM13LnXkOvnQl
✅ Task creation event sent: artist_introduction for Leonel Chavez
```

### 5. Check Webhook Server Logs (ngrok)

Should show:
```
📥 Received AI Setter event
Type: create_task
Contact: cx8QkqBYM13LnXkOvnQl
✅ Created artist_introduction task for Leonel Chavez
```

### 6. Check Supabase

Run this query:
```sql
SELECT 
  id,
  type,
  contact_name,
  assigned_to,
  status,
  trigger_event,
  metadata,
  created_at
FROM command_center_tasks
WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
AND type = 'artist_introduction'
ORDER BY created_at DESC
LIMIT 1;
```

Expected result:
```json
{
  "type": "artist_introduction",
  "contact_name": "Leonel Chavez",
  "assigned_to": ["1wuLf50VMODExBSJ9xPI"],
  "status": "pending",
  "trigger_event": "deposit_paid",
  "metadata": {
    "consultation_type": "message",
    "tattoo_size": "Small",
    "reason": "Message-based consultation - artist needs to introduce themselves",
    "route": "A"
  }
}
```

### 7. Check iOS App

1. Open Xcode
2. Run app in simulator
3. Log in as Claudia
4. Navigate to Command Center
5. Look for task:
   - Title: "Artist Introduction"
   - Contact: "Leonel Chavez"
   - Badge: "Message Consult" (blue badge with message icon)
   - Status: Pending

## If Task Still Doesn't Appear

### Check iOS App Console Logs

Look for:
```
📋 Fetching tasks for user: Claudia
🔄 API: Fetching tasks...
✅ Fetched [N] tasks
```

### Possible Issues

1. **Tasks not fetching**: Check network logs in Xcode
2. **Tasks filtered out**: Verify Claudia's GHL user ID matches `assigned_to`
3. **UI not refreshing**: Pull to refresh or restart app

### Debug Commands

**Check webhook server:**
```bash
cd /Users/studioaz/AZ\ Setter\ Cursor/studio-az-setter-backend
node check_webhook_server.js
```

**Check GHL fields:**
```bash
node -e "
const { getContact } = require('./src/clients/ghlClient');
getContact('cx8QkqBYM13LnXkOvnQl').then(c => {
  const cf = c?.customField || [];
  const consultField = cf.find(f => f.id === 'gM2PVo90yNBDHekV5G64');
  console.log('consultation_type:', consultField?.value || 'NOT SET');
});
"
```

## Success Criteria

- ✅ Render logs show `Consultation Type: message`
- ✅ Render logs show `✅ Task creation event sent: artist_introduction`
- ✅ Webhook server logs show task created
- ✅ Supabase has task record
- ✅ iOS app displays task in Command Center

## Next Steps After Success

Test other scenarios:
1. **Video consultation (English, Small)** → Should create `pre_consultation_notes` task
2. **Video consultation (Spanish)** → Should NOT create task
3. **Video consultation (English, Large)** → Should NOT create task

Toggle routes with:
```bash
CONSULTATION_ROUTE_TOGGLE=B node test_realistic_flow.js
```

