# WhatsApp Channel Selection Fix

## Summary

Updated the AI Setter bot to match the iOS app's channel selection logic: **WhatsApp is only used for international phone numbers**. US phone numbers always use SMS, even if the `whatsapp_user` custom field is set to "Yes".

## Problem

The contact `cx8QkqBYM13LnXkOvnQl` has:
- US phone number
- `whatsapp_user` custom field set to "Yes"

When the deposit was paid via Square webhook, the AI bot sent a confirmation message via WhatsApp instead of SMS because it only checked the `whatsapp_user` field, ignoring the fact that it was a US number.

## Solution

Implemented consistent channel selection logic across the entire backend that matches the iOS app:

### Rule
**Use WhatsApp ONLY if:**
1. `whatsapp_user` custom field = "Yes", AND
2. Phone number is international (non-US)

**For US phone numbers: Always use SMS**

## Changes Made

### 1. Added `isUSPhoneNumber()` Helper Function
Location: `src/server/app.js` and `src/clients/ghlClient.js`

Detects US phone numbers in various formats:
- `+16125551234` (US format with +1)
- `16125551234` (US format with 1 prefix)
- `6125551234` (10-digit US format)
- `(612) 555-1234` (formatted US number)

International numbers (non-US):
- `+52 55 1234 5678` (Mexico)
- `+44 20 7946 0958` (UK)
- `+91 98765 43210` (India)
- etc.

### 2. Updated `deriveChannelContext()` Function
Location: `src/server/app.js` (line ~164)

Now checks both `whatsapp_user` field AND phone number country code before selecting WhatsApp.

```javascript
const isUSPhone = isUSPhoneNumber(phone);
const isWhatsAppFromField = whatsappUser.toLowerCase() === "yes";

// Only use WhatsApp if explicitly enabled AND phone is international
const isWhatsApp = isWhatsAppFromField && !isUSPhone;
```

### 3. Updated Deposit Confirmation Channel Context
Location: `src/server/app.js` (line ~1049)

Deposit confirmation messages now use the same logic:

```javascript
const isUSPhone = isUSPhoneNumber(phone);
const useWhatsApp = hasWhatsAppEnabled && !isUSPhone;
```

### 4. Updated Safety Check in `sendConversationMessage()`
Location: `src/clients/ghlClient.js` (line ~1070)

Added US phone check to the existing WhatsApp safety validation:

```javascript
if (!hasWhatsAppEnabled || isUSPhone) {
  console.warn(`⚠️ [CHANNEL] Inferred WhatsApp but contact ${contactId} ${!hasWhatsAppEnabled ? "doesn't have WhatsApp enabled" : "has a US phone number"} - falling back to SMS`);
  type = "SMS";
}
```

## Testing

### Test Script
Created `test_phone_detection.js` with comprehensive test cases:
- ✅ All 12 phone number detection tests pass
- ✅ All 6 channel selection logic tests pass

Run tests:
```bash
cd /Users/studioaz/AZ\ Setter\ Cursor/studio-az-setter-backend
node test_phone_detection.js
```

### Manual Testing Steps

1. **Verify contact `cx8QkqBYM13LnXkOvnQl` phone number:**
   ```bash
   node check_whatsapp_setting.js
   ```
   Should show US phone number.

2. **Send a test message from iOS app:**
   - Go to Messages tab in iOS app
   - Send a message to the contact
   - AI bot should reply via SMS (not WhatsApp)

3. **Test deposit confirmation:**
   - Send a Square payment link
   - Complete payment
   - AI bot's deposit confirmation should arrive via SMS (not WhatsApp)

## Consistency Across Codebase

This change ensures the following components all use the same logic:

| Component | Location | Status |
|-----------|----------|--------|
| iOS App | `Conversation.swift` | ✅ Already implemented |
| AI Setter - Message Flow | `src/server/app.js` (deriveChannelContext) | ✅ Updated |
| AI Setter - Deposit Flow | `src/server/app.js` (Square webhook) | ✅ Updated |
| AI Setter - Safety Check | `src/clients/ghlClient.js` (sendConversationMessage) | ✅ Updated |

## Expected Behavior

### For US Phone Numbers (like your test contact)
- ✅ `whatsapp_user = "Yes"` → Use SMS (because US number)
- ✅ `whatsapp_user = "No"` → Use SMS

### For International Phone Numbers
- ✅ `whatsapp_user = "Yes"` → Use WhatsApp
- ✅ `whatsapp_user = "No"` → Use SMS

## Debugging

Added logging in deposit confirmation flow (when not in compact mode):

```
📱 [CHANNEL] Deposit confirmation channel selection:
  phone: "+16125551234"
  isUSPhone: true
  hasWhatsAppEnabled: true
  willUse: "SMS"
```

## Files Modified

1. `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/server/app.js`
   - Added `isUSPhoneNumber()` function
   - Updated `deriveChannelContext()` function
   - Updated deposit confirmation channel context
   - Added channel selection logging

2. `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/src/clients/ghlClient.js`
   - Added `isUSPhoneNumber()` function
   - Updated WhatsApp safety check in `sendConversationMessage()`

3. `/Users/studioaz/AZ Setter Cursor/studio-az-setter-backend/test_phone_detection.js` (NEW)
   - Test script for phone number detection logic
   - Test script for channel selection logic

## Next Steps

1. Deploy updated backend to Render
2. Test with contact `cx8QkqBYM13LnXkOvnQl`
3. Verify messages go through SMS instead of WhatsApp
4. Monitor logs for channel selection decisions
