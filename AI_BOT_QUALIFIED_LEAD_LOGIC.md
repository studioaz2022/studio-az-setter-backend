# AI Bot Qualified Lead Response Logic - Implementation Complete ✅

## Overview

Implemented two major features:
1. **AI Message Detection via userId** - iOS app now reliably detects AI messages for all channels (SMS, WhatsApp, Facebook, Instagram)
2. **Qualified Lead Response Logic** - AI bot intelligently limits responses after consultation is booked or artist is assigned

---

## Feature 1: AI Message Detection via userId

### Problem Solved
GHL trims trailing whitespace in SMS messages, causing the double-space marker to be removed. This prevented the iOS app from showing the "AI Response ✓" indicator for SMS messages.

### Solution
Use the `userId` field in messages to identify AI-sent messages instead of relying on text markers.

### Implementation

#### Backend Changes (`src/clients/ghlClient.js`)

**Added AI Bot user ID constant:**
```javascript
// AI Bot user ID in GHL - used to identify AI-sent messages in iOS app
const AI_BOT_USER_ID = "3dsbsgZpCWrDYCFPvhKu";
```

**Updated all message payloads to include userId:**
```javascript
const payload = {
  contactId,
  locationId: GHL_LOCATION_ID,
  message: markedBody,
  type, // "SMS", "WhatsApp", "FB", "IG", etc.
  userId: AI_BOT_USER_ID, // Mark as AI-sent for iOS app detection
};
```

**Applied to 4 different message sending paths:**
1. DM reply with conversationId
2. DM without conversationId (new conversation)
3. SMS/WhatsApp (phone-based)
4. Fallback inference path

#### iOS App Changes (`MessageThreadView.swift`)

**Added AI Bot userId constant:**
```swift
private static let aiBotUserId = "3dsbsgZpCWrDYCFPvhKu"
```

**Updated detection logic:**
```swift
private var isAIResponse: Bool {
    // Check userId first (works for all message types including SMS)
    if message.isOutbound, let userId = message.userId {
        if userId == Self.aiBotUserId {
            return true
        }
    }
    
    // Fallback to marker check for DM messages (Facebook/Instagram preserve trailing spaces)
    return message.isOutbound && (message.body?.hasSuffix(Self.aiMarker) ?? false)
}
```

### Benefits
- ✅ **Reliable for SMS** - No longer depends on trailing spaces
- ✅ **Zero cost** - No extra characters added to messages
- ✅ **Works everywhere** - SMS, WhatsApp, Facebook, Instagram
- ✅ **Backward compatible** - Still checks marker for older messages

---

## Feature 2: Qualified Lead Response Logic

### Business Rules

After a consultation is booked or artist is assigned, the AI bot should:
- **Stop auto-responding** to all messages from qualified leads
- **Only respond** if the lead asks an FAQ question
- **Always append `-FrontDesk`** suffix to FAQ responses so leads know it's not the artist

### Stage IDs for Qualified Leads

```javascript
const QUALIFIED_STAGE_IDS = [
  'd30d3a30-3a78-4123-9387-8db3d6dd8a20', // Consult Appointment (video scheduled)
  '09587a76-13ae-41b3-bd57-81da11f1c56c'  // Consult Message (artist handling)
];
```

### Implementation (`src/server/app.js`)

#### 1. Stage Detection Function
```javascript
function isInQualifiedStage(contact) {
  const cf = contact?.customField || contact?.customFields || {};
  const stageId = cf.opportunity_stage_id || cf.opportunityStageId;
  return QUALIFIED_STAGE_IDS.includes(stageId);
}
```

#### 2. FAQ Question Detection
Detects common pre-appointment questions:
- **Time/scheduling**: "what time", "when is", "appointment time"
- **Location**: "where", "address", "location", "directions"
- **Preparation**: "what should i bring", "how to prepare"
- **Logistics**: "parking", "how long", "duration"
- **Rescheduling**: "reschedule", "cancel", "change appointment"
- **Payment**: "how much", "cost", "price", "payment"
- **Aftercare**: "aftercare", "how to care", "healing"

```javascript
function detectFAQQuestion(text) {
  const lower = text.toLowerCase();
  const faqPatterns = [
    /what\s+time/i,
    /where\s+(is|are|do)/i,
    /parking/i,
    /reschedule/i,
    // ... 20+ patterns total
  ];
  return faqPatterns.some(pattern => pattern.test(lower));
}
```

#### 3. Response Decision Logic
```javascript
function shouldAIRespond(contact, messageText) {
  if (!isInQualifiedStage(contact)) {
    return { 
      shouldRespond: true, 
      reason: 'lead_not_qualified',
      appendFrontDesk: false
    };
  }
  
  const isFAQ = detectFAQQuestion(messageText);
  
  if (isFAQ) {
    return { 
      shouldRespond: true, 
      reason: 'qualified_faq_question',
      appendFrontDesk: true  // Add -FrontDesk suffix
    };
  }
  
  return { 
    shouldRespond: false, 
    reason: 'qualified_artist_handles',
    appendFrontDesk: false
  };
}
```

#### 4. Integration in Message Webhook

**Check before processing** (line ~730):
```javascript
const responseCheck = shouldAIRespond(contact, combinedMessageText);

if (!responseCheck.shouldRespond) {
  console.log(`⏭️ [AI SKIP] ${responseCheck.reason}`);
  return res.status(200).json({ 
    ok: true, 
    skipped: true, 
    reason: responseCheck.reason 
  });
}
```

**Add -FrontDesk suffix** (line ~790):
```javascript
for (const bubble of bubbles) {
  if (bubble && bubble.trim()) {
    let messageBody = bubble;
    if (responseCheck.appendFrontDesk) {
      messageBody = `${bubble}\n\n-FrontDesk`;
    }
    
    await sendConversationMessage({
      contactId,
      body: messageBody,
      channelContext,
    });
  }
}
```

---

## Testing Guide

### Test 1: AI Message Detection (SMS)
1. Send a message from iOS app to any contact
2. AI bot responds
3. **Expected**: Message shows "AI Response ✓" checkmark in iOS app

### Test 2: AI Message Detection (Facebook/Instagram)
1. Send a DM from Facebook or Instagram
2. AI bot responds
3. **Expected**: Message shows "AI Response ✓" checkmark in iOS app

### Test 3: Non-Qualified Lead
1. Message a contact in any stage EXCEPT the two qualified stages
2. Send any message
3. **Expected**: AI bot responds normally (no -FrontDesk suffix)

### Test 4: Qualified Lead - FAQ Question
1. Move contact to "Consult Appointment" or "Consult Message" stage
2. Send FAQ question: "What time is my appointment?"
3. **Expected**: 
   - AI bot responds
   - Response ends with `-FrontDesk`
   - iOS app shows "AI Response ✓" checkmark

### Test 5: Qualified Lead - Non-FAQ Message
1. Contact is in qualified stage
2. Send non-FAQ message: "I'm really excited about this!"
3. **Expected**: 
   - AI bot does NOT respond
   - Webhook returns `{ ok: true, skipped: true, reason: 'qualified_artist_handles' }`
   - Artist can see and respond manually

### Test 6: Check Logs
Look for these log messages:
```
⏭️ [AI SKIP] qualified_artist_handles
💬 [FAQ] Qualified lead asked FAQ question - AI will respond with -FrontDesk suffix
📨 Sending SMS via GHL: { ..., userId: "3dsbsgZpCWrDYCFPvhKu" }
```

---

## FAQ Patterns Reference

Current patterns detect:

### Time/Scheduling
- "what time"
- "when is/are"
- "appointment time"

### Location
- "where is/are/do"
- "address"
- "location"
- "how do i get"
- "directions"

### Preparation
- "what should i bring"
- "how to/do i prepare"
- "before my/the appointment"
- "what to expect/wear"

### Logistics
- "parking"
- "how long"
- "duration"
- "how much time"

### Rescheduling
- "reschedule"
- "cancel"
- "change my/appointment"
- "move my/appointment"

### Payment/Cost
- "how much"
- "cost"
- "price"
- "payment"
- "pay"

### Aftercare
- "aftercare"
- "how to care"
- "healing"

---

## Monitoring

### Key Metrics to Track
1. **AI Skip Rate** - % of messages from qualified leads that AI skips
2. **FAQ Response Rate** - % of qualified lead messages that are detected as FAQs
3. **False Positives** - Non-FAQ messages incorrectly identified as FAQs
4. **False Negatives** - FAQ messages incorrectly skipped

### Log Patterns to Monitor
```bash
# Find AI skips
grep "AI SKIP" logs

# Find FAQ responses
grep "FAQ.*FrontDesk" logs

# Find userId in messages
grep "userId.*3dsbsgZpCWrDYCFPvhKu" logs
```

---

## Future Enhancements

### Potential Additions
1. **More FAQ patterns** - Add patterns as you discover common questions
2. **Stage-specific FAQs** - Different FAQ patterns for different stages
3. **Smart learning** - Track which messages artists respond to, improve detection
4. **Admin override** - Custom field to force AI on/off for specific contacts
5. **FAQ response templates** - Pre-written responses for common questions

### Easy Modifications

**Add new FAQ pattern:**
```javascript
// In detectFAQQuestion function, add to faqPatterns array:
/new\s+pattern/i,
```

**Add new qualified stage:**
```javascript
// In QUALIFIED_STAGE_IDS array:
'new-stage-id-here', // Description
```

**Change -FrontDesk suffix:**
```javascript
// In bubble sending loop:
messageBody = `${bubble}\n\n-YourNewSignature`;
```

---

## Files Modified

### Backend
1. **src/clients/ghlClient.js**
   - Added `AI_BOT_USER_ID` constant
   - Updated all 4 message sending paths to include `userId`
   - Updated comments about AI marker behavior

2. **src/server/app.js**
   - Added `QUALIFIED_STAGE_IDS` constant
   - Added `isInQualifiedStage()` function
   - Added `detectFAQQuestion()` function
   - Added `shouldAIRespond()` function
   - Integrated checks in message webhook handler
   - Added -FrontDesk suffix logic in bubble sending

### iOS App
3. **Features/Messages/MessageThreadView.swift**
   - Added `aiBotUserId` constant
   - Updated `isAIResponse` computed property to check userId first
   - Kept marker check as fallback for backward compatibility

---

## Deployment Checklist

- ✅ Backend changes implemented
- ✅ iOS app changes implemented
- ✅ Documentation created
- ⬜ Deploy backend to Render
- ⬜ Build and test iOS app
- ⬜ Test with real contacts in production
- ⬜ Monitor logs for first 24 hours
- ⬜ Gather feedback from artists
- ⬜ Adjust FAQ patterns if needed

---

**Status:** ✅ Implementation Complete - Ready for Testing and Deployment
