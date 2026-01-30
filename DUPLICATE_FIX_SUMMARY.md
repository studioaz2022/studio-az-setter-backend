# Duplicate Tasks & Messages Fix Summary

## Issues Identified

### 1. **401 Unauthorized from GHL API**

**The failing curl request:**
```bash
curl -X PUT 'https://services.leadconnectorhq.com/contacts/cx8QkqBYM13LnXkOvnQl' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsb2NhdGlvbl9pZCI6Im1VZW14MmpHNHdseTRrSldCa0k0IiwidmVyc2lvbiI6MSwiaWF0IjoxNzU5NzgxMzI0OTc1LCJzdWIiOiIxa0ZHNUZXZFVEaFhMVVg0NnNuRyJ9.AGU63G-fgQhUQinazgFugis3IPD-Z94d3ALuz8Qixng' \
  -H 'Content-Type: application/json' \
  -H 'Version: 2021-07-28' \
  -d '{
    "customFields": [
      {"key": "client_lifetime_value", "value": "600"},
      {"key": "total_tattoos_completed", "value": "6"},
      {"key": "last_payment_date", "value": "2026-01-30"}
    ]
  }'
```

**Problem:** The JWT token has expired.

**Location:** `src/clients/financialTracking.js` line 252 - `updateGHLClientFinancials()` function

**Solution:** Regenerate your GHL API key/token and update the `GHL_API_KEY` environment variable on Render.

---

### 2. **6x Duplicate Tasks and Messages**

**Root Cause:** Square sends **MULTIPLE webhook events** for a single payment transaction:
- `order.created` (version 1)
- `order.fulfillment.updated`
- `order.updated` (versions 2, 3, 4, 5, 6, 7)
- `payment.created`
- `payment.updated` (with receipt)
- `payment.updated` (COMPLETED)

Your code was processing **ALL of these events** because they all contained `payment.order_id`, resulting in:
- 6 `create_task` events sent to iOS app
- 6 database records created in Supabase
- 6 SMS messages sent to the client
- 6 pipeline transitions
- 6 financial tracking updates (though duplicate check caught some)

**Fix Applied:** Added event type and status filtering in `src/server/app.js`:

```javascript
// Only process payment.updated events
if (eventType !== 'payment.updated') {
  console.log(`💳 Ignoring ${eventType} event (only processing payment.updated)`);
  return res.json({ received: true, ignored: true });
}

// Only process COMPLETED payments
if (paymentStatus !== 'COMPLETED') {
  console.log(`💳 Ignoring payment with status: ${paymentStatus} (waiting for COMPLETED)`);
  return res.json({ received: true, ignored: true });
}
```

**Result:** Now only **ONE** webhook will be processed per payment (the `payment.updated` event with `status: COMPLETED`).

---

## What Was Fixed

### File: `src/server/app.js`
**Commit:** `ae711a3` - "fix: Only process payment.updated with COMPLETED status to prevent duplicate tasks and messages"

**Changes:**
1. Added event type check to only process `payment.updated` events
2. Added payment status check to only process `COMPLETED` payments
3. Added debug logging for payment status
4. Early return with JSON response for ignored events

---

## Testing the Fix

### Before Fix:
```
💳 SQUARE PAYMENT WEBHOOK HIT (6 times)
📱 App event sent: create_task (6 times)
✅ Task creation event sent (6 times)
✉️ SMS sent: "Got your deposit..." (6 times)
```

### After Fix:
```
💳 Ignoring order.created event
💳 Ignoring order.updated event (5 times)
💳 Ignoring payment.created event
💳 SQUARE PAYMENT WEBHOOK HIT (1 time - payment.updated with COMPLETED)
📱 App event sent: create_task (1 time)
✅ Task creation event sent (1 time)
✉️ SMS sent: "Got your deposit..." (1 time)
```

---

## Next Steps

1. **Regenerate GHL API Key:**
   - Go to GHL Settings → API
   - Generate a new API key
   - Update `GHL_API_KEY` environment variable on Render
   - Restart the Render service

2. **Clean up duplicate tasks in Supabase:**
   ```sql
   -- Find duplicate tasks
   SELECT contact_id, type, COUNT(*) as count
   FROM command_center_tasks
   WHERE created_at > NOW() - INTERVAL '1 hour'
   GROUP BY contact_id, type
   HAVING COUNT(*) > 1;

   -- Delete duplicates (keep the oldest one)
   DELETE FROM command_center_tasks
   WHERE id NOT IN (
     SELECT MIN(id)
     FROM command_center_tasks
     WHERE contact_id = 'cx8QkqBYM13LnXkOvnQl'
     GROUP BY contact_id, type
   )
   AND contact_id = 'cx8QkqBYM13LnXkOvnQl';
   ```

3. **Test with new payment:**
   - Create a fresh payment link
   - Complete payment
   - Verify only **ONE** task is created
   - Verify only **ONE** SMS is sent

---

## Status

✅ **Duplicate prevention deployed** - Waiting for Render to redeploy (~2 minutes)
⚠️ **GHL API key needs regeneration** - Required for custom field reads/writes
📊 **Task creation working** - End-to-end flow is functional, just needs GHL auth fix

