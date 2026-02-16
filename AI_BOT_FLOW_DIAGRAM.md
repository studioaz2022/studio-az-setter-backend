# AI Bot Decision Flow

```
                              ┌─────────────────────┐
                              │  Message Received   │
                              │   from Contact      │
                              └──────────┬──────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │  Fetch Contact      │
                              │  from GHL           │
                              └──────────┬──────────┘
                                         │
                                         ▼
                        ┌────────────────────────────────┐
                        │  Check Opportunity Stage ID    │
                        └────────────┬───────────────────┘
                                     │
                 ┌───────────────────┴───────────────────┐
                 │                                       │
                 ▼                                       ▼
      ┌──────────────────────┐              ┌──────────────────────┐
      │  NOT in Qualified    │              │  IN Qualified Stage  │
      │  Stage               │              │  (Consult Appt or    │
      │                      │              │   Consult Message)   │
      └──────────┬───────────┘              └──────────┬───────────┘
                 │                                     │
                 │                                     ▼
                 │                          ┌──────────────────────┐
                 │                          │  Is message an       │
                 │                          │  FAQ question?       │
                 │                          └──────────┬───────────┘
                 │                                     │
                 │                     ┌───────────────┴───────────────┐
                 │                     │                               │
                 │                     ▼                               ▼
                 │          ┌──────────────────┐          ┌──────────────────┐
                 │          │  YES - FAQ       │          │  NO - Regular    │
                 │          │  Question        │          │  Message         │
                 │          └──────────┬───────┘          └──────────┬───────┘
                 │                     │                              │
                 │                     ▼                              ▼
                 │          ┌──────────────────┐          ┌──────────────────┐
                 │          │  AI RESPONDS     │          │  AI SKIPS        │
                 │          │  with -FrontDesk │          │  (Artist handles)│
                 │          │  suffix          │          └──────────────────┘
                 │          └──────────────────┘
                 │
                 ▼
      ┌──────────────────────┐
      │  AI RESPONDS         │
      │  (Normal, no suffix) │
      └──────────┬───────────┘
                 │
                 ▼
      ┌──────────────────────┐
      │  Send to GHL with    │
      │  userId =            │
      │  "3dsbsgZpCWrDYC..."  │
      └──────────┬───────────┘
                 │
                 ▼
      ┌──────────────────────┐
      │  iOS App Detects     │
      │  AI Response via     │
      │  userId              │
      └──────────────────────┘
```

## Stage IDs Reference

| Stage Name | Stage ID | AI Behavior |
|-----------|----------|-------------|
| Discovery, Intake, etc. | (any other) | ✅ Responds to all messages |
| **Consult Appointment** | `d30d3a30-3a78-4123-9387-8db3d6dd8a20` | ⚠️ Only FAQ questions |
| **Consult Message** | `09587a76-13ae-41b3-bd57-81da11f1c56c` | ⚠️ Only FAQ questions |

## FAQ Detection Examples

### ✅ Will Trigger AI Response (FAQ)
- "What time is my appointment?"
- "Where are you located?"
- "What should I bring?"
- "How long will it take?"
- "Can I reschedule?"
- "How much does it cost?"
- "What's the parking situation?"
- "How do I prepare for my appointment?"

### ❌ Will NOT Trigger AI Response (Not FAQ)
- "I'm so excited!"
- "Thanks for everything!"
- "Looking forward to it"
- "Can you add more flowers to the design?"
- "I changed my mind about the placement"
- "Do you have reference photos?"

## Message Flow with userId

```
Backend:
┌────────────────────────────────────────┐
│ AI generates response: "Hello!"       │
│                                        │
│ Payload to GHL:                        │
│ {                                      │
│   contactId: "cx8...",                 │
│   message: "Hello!  ",  ← double space │
│   type: "SMS",                         │
│   userId: "3dsbsgZpCWrDYCFPvhKu" ← KEY │
│ }                                      │
└────────────────────────────────────────┘
                   │
                   ▼
        ┌──────────────────┐
        │  GHL API         │
        │  Stores message  │
        └──────────────────┘
                   │
                   ▼
iOS App:
┌────────────────────────────────────────┐
│ Fetches messages from GHL              │
│                                        │
│ For SMS: "Hello!" (spaces trimmed)     │
│ But userId preserved: "3dsbsgZ..."     │
│                                        │
│ Detection:                             │
│ if userId == "3dsbsgZpCWrDYCFPvhKu" {  │
│   showAIIndicator = true ✓             │
│ }                                      │
└────────────────────────────────────────┘
```

## Response Format Examples

### Non-Qualified Lead Response
```
Lead: "I want a sleeve tattoo"

AI: "A sleeve tattoo is a great choice! What style are you thinking about - 
     Japanese, traditional, realism, or something else?"
```

### Qualified Lead FAQ Response
```
Lead: "What time is my appointment?"

AI: "Your consultation is scheduled for tomorrow at 3:00 PM at our studio 
     located at 123 Main St. See you then!
     
     -FrontDesk"
```

### Qualified Lead Non-FAQ (No Response)
```
Lead: "I'm thinking of adding more elements to my design"

AI: (no response - artist sees message and responds manually)
```

---

**Color Key:**
- ✅ Green = AI responds
- ⚠️ Yellow = AI responds conditionally (FAQ only)
- ❌ Red = AI skips (artist handles)
