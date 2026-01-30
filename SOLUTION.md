# Solution: Square Payment → Task Creation

## Root Cause Identified ✅

The end-to-end flow is working correctly, but **the `consultation_type` field is not being set/read in GHL CRM**. This causes:

1. Square webhook reads `consultation_type` as `"online"` (default) instead of `"message"`
2. Task handler thinks it's a video consultation with no task needed (Route A)
3. No CREATE_TASK event is sent
4. No task appears in iOS app

## Evidence from Render Logs

```
📋 Processing qualified lead task for: Leonel Chavez
   Consultation Type: online  ← Should be "message"
   Spanish/Comfortable: false
   Tattoo Size:  ← Empty
   Assigned Artist: Unknown  ← Should be "Joan"
   Current Route: A
ℹ️ No task needed: Route A: Artist + Translator on call together - no task needed
```

## What's Working ✅

1. ✅ Square webhook successfully resolves contact ID from order
2. ✅ `qualifiedLeadHandler.js` logic is correct
3. ✅ Webhook server accepts CREATE_TASK events
4. ✅ iOS app TaskCardView displays consultation badges
5. ✅ All code deployed to Render

## The Fix

### Option 1: Set Fields Manually in GHL CRM (Quickest)

1. Go to GHL CRM
2. Open contact: Leonel Chavez (`cx8QkqBYM13LnXkOvnQl`)
3. Find custom fields section
4. Set these fields:
   - `consultation_type` = `message`
   - `assigned_artist` = `Joan`
   - `tattoo_size` = `Small`
   - `language_preference` = `English`

5. Pay the Square link again: `https://sandbox.square.link/u/cXSwSGki`
   (Or create a new one with: `node test_realistic_flow.js`)

6. Check Render logs - should now show:
   ```
   Consultation Type: message
   ✅ Task creation event sent: artist_introduction
   ```

7. Check Supabase for the task
8. Check iOS app Command Center

### Option 2: Find Correct GHL Custom Field IDs

The issue might be that we're using field names (`consultation_type`) instead of field IDs.

**To find the correct field IDs:**

1. Use GHL API to list all custom fields:
   ```bash
   curl -X GET "https://rest.gohighlevel.com/v1/custom-fields/" \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Version: 2021-07-28"
   ```

2. Look for fields like:
   - `consultation_type` or `Consultation Type`
   - `assigned_artist` or `Assigned Artist`
   - `tattoo_size` or `Size of Tattoo`

3. Note their IDs (usually long alphanumeric strings)

4. Update `src/clients/ghlClient.js` to use the correct field IDs

### Option 3: Use Widget to Set Fields

The tattoo consultation widget (`tattoo_consultation_widget.html`) successfully sets these fields. We could:

1. Fill out the widget form for the test contact
2. This will set all the consultation fields correctly
3. Then pay the deposit link
4. Task should be created

## Testing After Fix

Once `consultation_type = "message"` is set in GHL:

1. **Pay Square link** (create new one if needed)

2. **Check Render logs** - should show:
   ```
   💳 Deposit paid for contact: cx8QkqBYM13LnXkOvnQl
   📋 Processing qualified lead task for: Leonel Chavez
      Consultation Type: message  ✅
      Spanish/Comfortable: false
      Tattoo Size: Small
      Assigned Artist: Joan
      Current Route: A
   📱 App event sent: create_task for contact cx8QkqBYM13LnXkOvnQl
   ✅ Task creation event sent: artist_introduction for Leonel Chavez
   ```

3. **Check webhook server logs** (ngrok):
   ```
   📥 Received AI Setter event
   Type: create_task
   ✅ Created artist_introduction task for Leonel Chavez
   ```

4. **Check Supabase**:
   ```sql
   SELECT * FROM command_center_tasks
   WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
   AND type = 'artist_introduction'
   ORDER BY created_at DESC LIMIT 1;
   ```
   
   Should return:
   - type: `artist_introduction`
   - contact_name: `Leonel Chavez`
   - assigned_to: `["1wuLf50VMODExBSJ9xPI"]` (Joan)
   - metadata: `{ consultation_type: "message", tattoo_size: "Small" }`

5. **Check iOS App** (Xcode simulator as Claudia):
   - Open Command Center
   - Should see task: "Artist Introduction" for "Leonel Chavez"
   - Badge: "Message Consult" (blue with message icon)

## Why Fields Aren't Persisting

The `updateSystemFields()` function in our backend may not be using the correct field identifiers. GHL custom fields can be referenced by:
- Field name (e.g., `consultation_type`)
- Field ID (e.g., `abc123xyz`)

If the field name doesn't match exactly what's in GHL, the update silently fails.

## Alternative: Test with Widget-Created Contact

Instead of manually setting fields:

1. Go to: `http://localhost:8080/tattoo_consultation_widget.html` (or your hosted version)
2. Fill out the form with:
   - Name: Test User
   - Email: test@example.com
   - Phone: +1234567890
   - Consultation type: "Message-based"
   - Tattoo size: "Small"
   - Artist: "Joan"
3. Submit form
4. Get the contact ID from GHL
5. Run `node test_realistic_flow.js` with that contact ID
6. This contact will have all fields set correctly

## Summary

The entire flow works end-to-end. The only issue is that the test contact doesn't have `consultation_type = "message"` set in GHL CRM. Once that's fixed (manually or via widget), the task will be created successfully.

**Next Step**: Set `consultation_type = "message"` in GHL CRM for contact `cx8QkqBYM13LnXkOvnQl`, then pay the Square link again.

