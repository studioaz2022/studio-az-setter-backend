# Quick Reference: AI Bot Behavior After Qualification

## When Does AI Bot Stop Auto-Responding?

After contact reaches one of these stages:
- ✅ **Consult Appointment** (`d30d3a30-3a78-4123-9387-8db3d6dd8a20`) - Video consultation scheduled
- ✅ **Consult Message** (`09587a76-13ae-41b3-bd57-81da11f1c56c`) - Artist assigned for message-based consultation

## AI Bot Response Matrix

| Stage | Lead Message Type | AI Responds? | Signature |
|-------|------------------|--------------|-----------|
| **Any other stage** | Any message | ✅ YES | (none) |
| **Qualified** | FAQ question | ✅ YES | `-FrontDesk` |
| **Qualified** | Non-FAQ message | ❌ NO | (artist handles) |

## What Counts as an FAQ Question?

Common pre-appointment questions:
- 🕐 **Time**: "what time", "when is my appointment"
- 📍 **Location**: "where", "address", "directions", "parking"
- 🎒 **Prep**: "what should i bring", "how to prepare"
- ⏱️ **Duration**: "how long", "duration"
- 🔄 **Reschedule**: "reschedule", "cancel", "change appointment"
- 💰 **Cost**: "how much", "price", "payment"
- 💊 **Aftercare**: "aftercare", "how to care", "healing"

## Example Interactions

### ✅ Scenario 1: Qualified Lead Asks FAQ
**Contact Stage:** Consult Appointment  
**Lead Message:** "What time is my appointment tomorrow?"  
**AI Response:** "Your consultation is at 3:00 PM tomorrow at our studio. See you then! -FrontDesk"  
**iOS App:** Shows "AI Response ✓" checkmark

### ❌ Scenario 2: Qualified Lead Non-FAQ
**Contact Stage:** Consult Message  
**Lead Message:** "I'm so excited! Can't wait to see the design."  
**AI Response:** (none - artist sees and responds)

### ✅ Scenario 3: Non-Qualified Lead
**Contact Stage:** Discovery  
**Lead Message:** "I'm so excited! Can't wait to see the design."  
**AI Response:** "Me too! We're going to create something amazing. Have you thought about which colors you'd like?" (no -FrontDesk suffix)

## How to Identify AI Messages in iOS App

### SMS Messages
- ✅ Checks `message.userId` == `"3dsbsgZpCWrDYCFPvhKu"`
- Shows "AI Response ✓" indicator

### Facebook/Instagram DMs
- ✅ Checks `message.userId` first
- ✅ Falls back to checking for double-space suffix (preserves spaces)
- Shows "AI Response ✓" indicator

### WhatsApp Messages
- ✅ Checks `message.userId` == `"3dsbsgZpCWrDYCFPvhKu"`
- Shows "AI Response ✓" indicator

## Quick Troubleshooting

### AI responded when it shouldn't have
1. Check contact stage ID in GHL custom fields
2. Verify stage ID matches one of the qualified stages
3. Check if message matched an FAQ pattern (might be false positive)

### AI didn't respond to FAQ
1. Check if contact is in qualified stage
2. Test if message matches FAQ patterns
3. Check logs for: `⏭️ [AI SKIP] qualified_artist_handles`
4. Consider adding new FAQ pattern if needed

### iOS app not showing "AI Response ✓"
1. Check if message has `userId` field
2. Verify userId matches: `3dsbsgZpCWrDYCFPvhKu`
3. Check message in GHL - should have userId field
4. For older messages, may need to rely on double-space marker

## Adding New FAQ Patterns

Edit `src/server/app.js` → `detectFAQQuestion()` function:

```javascript
const faqPatterns = [
  // ... existing patterns ...
  /your\s+new\s+pattern/i,  // Add your pattern here
];
```

Restart server after changes.

## Log Messages to Look For

### AI Skipped (Qualified Lead, Non-FAQ)
```
⏭️ [AI SKIP] qualified_artist_handles
   Stage ID: d30d3a30-3a78-4123-9387-8db3d6dd8a20
   Message: "I'm so excited!..."
```

### AI Responded to FAQ
```
💬 [FAQ] Qualified lead asked FAQ question - AI will respond with -FrontDesk suffix
```

### Message Sent with AI Bot userId
```
📨 Sending SMS via GHL: {
  contactId: "cx8...",
  message: "...",
  type: "SMS",
  userId: "3dsbsgZpCWrDYCFPvhKu"
}
```

---

**Need to adjust behavior?** Contact dev team or edit:
- Backend: `/src/server/app.js` (line ~150 for FAQ patterns, line ~730 for checks)
- iOS: `/Features/Messages/MessageThreadView.swift` (line ~997 for detection)
