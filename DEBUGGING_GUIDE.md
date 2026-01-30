# Square Payment → Task Creation Debugging Guide

## Current Status

### ✅ What's Working
1. **Webhook Server**: Running and accepting CREATE_TASK events
2. **Task Creation Logic**: `qualifiedLeadHandler.js` correctly determines tasks
3. **Event Sending**: Backend sends CREATE_TASK events to webhook server
4. **Test Scripts**: All test scripts work locally

### ❌ What's Broken
1. **Square Webhook**: Cannot resolve `contactId` from payment webhooks
2. **GHL Field Sync**: Field updates may not persist (eventual consistency)

## Issue 1: Square Webhook ContactId Resolution

### Problem
Render logs show:
```
⚠️ /square/webhook could not resolve contactId from payment
```

This means the Square payment webhook isn't finding the contact ID from the payment.

### Debugging Added
I've added detailed logging to `src/server/app.js` that will now show:
- Payment object keys
- Order ID
- Reference ID from payment
- Full payload when contactId cannot be resolved

### Next Steps
1. **Wait for Render deployment** (~2-3 minutes)
   - Check: https://studio-az-setter-backend.onrender.com/
   
2. **Pay the Square link again**:
   ```
   https://sandbox.square.link/u/cXSwSGki
   OR create a new one with: node test_realistic_flow.js
   ```

3. **Check Render logs** after payment:
   - Go to: https://dashboard.render.com/
   - Find your backend service
   - View logs
   - Look for `💳 [DEBUG]` messages showing the payment structure

4. **Send me the logs** - specifically:
   - `💳 [DEBUG] Payment object keys: [...]`
   - `💳 [DEBUG] Order ID: ...`
   - `💳 [DEBUG] Reference ID from payment: ...`
   - `💳 [DEBUG] Payload: {...}` (if contactId still can't be resolved)

### Possible Causes
1. Square payment doesn't include `reference_id` directly
2. Order ID lookup is failing
3. Order doesn't have `reference_id` set
4. Payment link creation didn't properly set `reference_id` on the order

## Issue 2: Task Not Appearing in iOS App

### Verification Steps

#### 1. Check Webhook Server Received Event
Run the diagnostic script:
```bash
cd /Users/studioaz/AZ\ Setter\ Cursor/studio-az-setter-backend
node check_webhook_server.js
```

This will:
- Test webhook server connectivity
- Send a test CREATE_TASK event
- Show success/failure

#### 2. Check Supabase Database
Open Supabase SQL Editor and run:
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
ORDER BY created_at DESC
LIMIT 5;
```

Expected result:
- Type: `artist_introduction`
- Contact: `Test Contact` or `Leonel Chavez`
- Assigned to: `["1wuLf50VMODExBSJ9xPI"]` (Joan)
- Status: `pending`

#### 3. Check iOS App Logs in Xcode

When logged in as Claudia, check for:

**Task Fetching**:
```
📋 Fetching tasks for user: Claudia
🔄 API: Fetching tasks...
✅ Fetched [N] tasks
```

**Task Display**:
```
📋 Task: [task type] for [contact name]
```

**Possible Issues**:
- Tasks not being fetched from Supabase
- Tasks filtered out (wrong user ID, wrong location)
- UI not updating/refreshing

### iOS App Console Logs Needed

Please provide:
1. **Launch logs** - When app opens
2. **Command Center logs** - When Command Center view loads
3. **Task fetch logs** - API calls to fetch tasks
4. **Any errors** - Red error messages

To get logs in Xcode:
1. Run app in simulator with Claudia logged in
2. Open Console pane (View → Debug Area → Activate Console)
3. Navigate to Command Center
4. Look for logs with `📋`, `✅`, `❌` emojis
5. Copy and send all relevant logs

## Test Contact Setup

**Contact**: Leonel Chavez (`cx8QkqBYM13LnXkOvnQl`)
- Assigned to: Claudia (`Wl24x1ZrucHuHatM0ODD`)
- Consultation type: `message`
- Language: `English`
- Tattoo size: `Small`
- Assigned artist: `Joan`

**Expected Task**:
- Type: `artist_introduction`
- Badge: "Message Consult" (blue badge with message icon)
- Assigned to: Joan (`1wuLf50VMODExBSJ9xPI`)
- Should appear in Claudia's Command Center

## Quick Tests

### Test 1: Webhook Server
```bash
node check_webhook_server.js
```
Should show: ✅ Webhook server is running and accepting events

### Test 2: Task Handler Logic
```bash
CONSULTATION_ROUTE=A node -e "
const { handleQualifiedLeadTasks } = require('./src/ai/qualifiedLeadHandler');
handleQualifiedLeadTasks({
  contactId: 'cx8QkqBYM13LnXkOvnQl',
  contactName: 'Test',
  consultationType: 'message',
  isSpanishOrComfortable: false,
  tattooSize: 'Small',
  assignedArtist: 'Joan'
}).then(r => console.log('Result:', JSON.stringify(r, null, 2)));
"
```
Should show: Task creation event sent for `artist_introduction`

### Test 3: Full Flow (Local)
```bash
node test_realistic_flow.js
```
Should:
1. Assign contact to Claudia
2. Create Square payment link
3. Simulate payment webhook
4. Send CREATE_TASK event
5. Show success

## Files Changed

### Backend (`studio-az-setter-backend`)
- ✅ `src/ai/qualifiedLeadHandler.js` (NEW) - Task determination logic
- ✅ `src/server/app.js` - Added task handler integration + debugging
- ✅ `src/clients/appEventClient.js` - Added CREATE_TASK event type

### Webhook Server (`webhook_server`)
- ✅ `index.js` - Already has CREATE_TASK handler (no changes needed)

### iOS App
- ✅ `TaskCardView.swift` - Already displays consultation type badge (no changes needed)

## Environment Variables

Make sure these are set in Render:
- `CONSULTATION_ROUTE_TOGGLE=A` (or `B`)
- `APP_WEBHOOK_URL=https://circuitous-nonstructurally-valerie.ngrok-free.dev`
- `SQUARE_WEBHOOK_SECRET=[your secret]`
- `SQUARE_ACCESS_TOKEN=[your token]`
- `SQUARE_LOCATION_ID=[your location]`

## Next Actions

1. **Wait for Render to deploy** (~2-3 min)
2. **Pay Square link** or create new one
3. **Check Render logs** for debug output
4. **Send me**:
   - Render logs (Square webhook debug output)
   - iOS app console logs (Command Center)
   - Supabase query results (command_center_tasks table)
5. I'll fix the contact ID resolution issue
6. Test again and verify task appears in iOS app

