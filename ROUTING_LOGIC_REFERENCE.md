# 🧭 Lead Flow Routing Logic - Quick Reference

---

## 📋 Decision Tree

```
After Deposit Paid
│
├─ Consultation Type: MESSAGE
│  └─ ✅ CREATE TASK: artist_introduction
│     • Badge: "Message Consult"
│     • Artist introduces themselves via messages
│
└─ Consultation Type: VIDEO (ONLINE)
   │
   ├─ Lead speaks Spanish OR comfortable with Spanish
   │  └─ ❌ NO TASK
   │     • Appointment appears on calendar
   │     • Push notification sent
   │
   └─ Lead speaks English ONLY
      │
      ├─ ROUTE A (CONSULTATION_ROUTE_TOGGLE=A)
      │  │
      │  ├─ Tattoo Size: Fine Line, Small, Medium Low Coverage
      │  │  └─ ✅ CREATE TASK: pre_consultation_notes
      │  │     • Badge: "Video Consult (Admin)"
      │  │     • Admin will lead consultation
      │  │     • Artist reviews details and adds notes
      │  │
      │  └─ Tattoo Size: Medium High Coverage, Large
      │     └─ ❌ NO TASK
      │        • Artist + Translator on call together
      │        • Appointment appears on calendar
      │
      └─ ROUTE B (CONSULTATION_ROUTE_TOGGLE=B)
         └─ ALL SIZES
            └─ ❌ NO TASK
               • Artist + Translator always on call together
               • Appointment appears on calendar
```

---

## 🎛️ Toggle Between Routes

**Environment Variable:** `CONSULTATION_ROUTE_TOGGLE`

### Set to Route A (Admin-led for small tattoos):
```bash
# In studio-az-setter-backend/.env
CONSULTATION_ROUTE_TOGGLE=A
```

### Set to Route B (Artist + Translator always):
```bash
# In studio-az-setter-backend/.env
CONSULTATION_ROUTE_TOGGLE=B
```

**To apply changes:** Restart the backend server on Render or locally.

---

## 📊 Task Creation Matrix

| Consultation | Language | Size | Route | Task Created? | Task Type |
|--------------|----------|------|-------|---------------|-----------|
| **Message** | Any | Any | Any | ✅ YES | `artist_introduction` |
| **Video** | Spanish/Comfortable | Any | Any | ❌ NO | - |
| **Video** | English-only | Fine Line | **A** | ✅ YES | `pre_consultation_notes` |
| **Video** | English-only | Small | **A** | ✅ YES | `pre_consultation_notes` |
| **Video** | English-only | Medium Low | **A** | ✅ YES | `pre_consultation_notes` |
| **Video** | English-only | Medium High | **A** | ❌ NO | - |
| **Video** | English-only | Large | **A** | ❌ NO | - |
| **Video** | English-only | Any size | **B** | ❌ NO | - |

---

## 🏷️ Task Type Details

### `artist_introduction`
- **When:** Message-based consultation
- **Purpose:** Artist introduces themselves and begins discussion
- **Badge:** "Message Consult"
- **Assigned To:** Selected artist from consultation form

### `pre_consultation_notes`
- **When:** Video consultation, English-only, small tattoo, Route A
- **Purpose:** Artist reviews details and adds notes before Admin-led call
- **Badge:** "Video Consult (Admin)"
- **Assigned To:** Selected artist from consultation form

---

## 🔍 How to Check Current Route

Run this in backend directory:
```bash
grep CONSULTATION_ROUTE_TOGGLE .env
```

Or check in code:
```javascript
// In qualifiedLeadHandler.js
const CONSULTATION_ROUTE_TOGGLE = process.env.CONSULTATION_ROUTE_TOGGLE || 'A';
console.log('Current Route:', CONSULTATION_ROUTE_TOGGLE);
```

---

## 🧪 Testing Each Scenario

### Test Message Consultation:
```bash
# Set up contact
consultation_type: "message"
language_preference: "English"
tattoo_size: "Small"
assigned_artist: "Claudia"

# Expected: artist_introduction task created
```

### Test Spanish Video Consultation:
```bash
# Set up contact
consultation_type: "online"
language_preference: "Spanish"
tattoo_size: "Medium, Low Coverage"
assigned_artist: "Joan"

# Expected: NO task (appointment only)
```

### Test English Video, Route A, Small Tattoo:
```bash
# Set up contact
consultation_type: "online"
language_preference: "English"
lead_spanish_comfortable: "No"
tattoo_size: "Small"
assigned_artist: "Maria"

# Expected: pre_consultation_notes task created
```

### Test English Video, Route A, Large Tattoo:
```bash
# Set up contact
consultation_type: "online"
language_preference: "English"
lead_spanish_comfortable: "No"
tattoo_size: "Large"
assigned_artist: "Joan"

# Expected: NO task (Artist + Translator on call)
```

### Test Route B (any size):
```bash
# Change env
CONSULTATION_ROUTE_TOGGLE=B

# Set up contact
consultation_type: "online"
language_preference: "English"
lead_spanish_comfortable: "No"
tattoo_size: "Any"
assigned_artist: "Any"

# Expected: NO task (Artist + Translator always on call)
```

---

## 📱 iOS App Display

### Task Card Badge Colors:
- **Message Consult:** Blue badge with chat bubble icon
- **Video Consult (Admin):** Blue badge with video icon
- **Video Consult (Translator):** Blue badge with video icon

### Badge determines from metadata:
```swift
if consultationType == "message" {
    "Message Consult"
} else if cardNote.contains("Admin will lead") {
    "Video Consult (Admin)"
} else {
    "Video Consult (Translator)"
}
```

---

## 🚨 Troubleshooting

### Task not created?
1. Check `consultation_type` field in GHL (must be "message" or "online")
2. Check `tattoo_size` field (must match exact values)
3. Check `assigned_artist` or `inquired_technician` is set
4. Check Render logs for "Processing qualified lead task"
5. Check webhook server logs for "Processing create_task event"

### Wrong task type created?
1. Verify `CONSULTATION_ROUTE_TOGGLE` setting
2. Check `language_preference` and `lead_spanish_comfortable` fields
3. Check `tattoo_size` matches expected values

### Task not showing in iOS app?
1. Verify task exists in Supabase `command_center_tasks`
2. Check `assigned_to` array contains correct GHL user ID
3. Verify artist is logged into iOS app with matching user ID

---

**Quick Test Command:**
```bash
cd /Users/studioaz/AZ\ Setter\ Cursor/studio-az-setter-backend
node check_webhook_server.js
```

