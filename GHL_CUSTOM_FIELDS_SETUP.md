# GoHighLevel Custom Fields Setup Guide

This document lists all custom fields required for the Studio AZ AI Setter system.

## ⚠️ IMPORTANT: All Fields Should Be Single Line Text

**All custom fields should be created as "Single Line Text" fields in GHL.** The code is designed to handle:
- **Boolean values** stored as text (`"true"`, `"false"`, `"Yes"`, `"No"`) - the `boolField()` helper reads these correctly
- **Dropdown values** stored as text (`"intake"`, `"hot"`, `"message"`) - already strings
- **Date values** stored as ISO timestamp strings (`"2024-12-10T15:30:00.000Z"`) - already strings
- **Numeric values** stored as text (`"100"`, `"5"`) - can be parsed when needed

This simplifies setup and ensures consistency across all fields.

---

## 📋 SYSTEM FIELDS (AI & Workflow Control)

| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `ai_phase` | Single Line Text | `intake`, `discovery`, `qualification`, `closing`, `objections`, `routing`, `handoff`, `reengagement`, `consult_support` | Current AI conversation phase |
| `lead_temperature` | Single Line Text | `hot`, `warm`, `cold`, `disqualified` | Lead intent level |
| `language_preference` | Single Line Text | `English`, `Spanish` | User's preferred language |
| `last_phase_update_at` | Single Line Text | ISO timestamp (e.g., `2024-12-10T15:30:00.000Z`) | Last time AI phase changed |
| `consult_explained` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether consult process was explained |
| `language_barrier_explained` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether Spanish/translator explanation was sent |
| `deposit_confirmation_sent` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether deposit confirmation DM was sent (idempotency) |

---

## 💰 DEPOSIT & PAYMENT FIELDS

| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `deposit_paid` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether $100 deposit has been paid |
| `deposit_link_sent` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether deposit link was sent to lead |
| `deposit_link_url` | Single Line Text | URL string | The actual Square payment link URL (for reuse) |
| `square_payment_link_id` | Single Line Text | Square payment link ID | Square payment link identifier |

---

## 📅 CONSULTATION & BOOKING FIELDS

| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `consultation_type` | Single Line Text | `appointment`, `message` | Video call with translator OR message-based consult |
| `translator_needed` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether translator is needed for video consult |
| `translator_appointment_id` | Single Line Text | GHL appointment ID | ID of translator calendar appointment |
| `times_sent` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether time slot options were sent to lead |

### Pending Slot Fields (for crash recovery)
| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `pending_slot_start` | Single Line Text | ISO timestamp | Start time of pending slot |
| `pending_slot_end` | Single Line Text | ISO timestamp | End time of pending slot |
| `pending_slot_display` | Single Line Text | Human-readable (e.g., "Wednesday, Dec 10 at 5pm") | Display text for pending slot |
| `pending_slot_artist` | Single Line Text | `Joan`, `Andrew` | Artist assigned to pending slot |
| `pending_slot_calendar` | Single Line Text | GHL calendar ID | Calendar ID for pending slot |
| `pending_slot_mode` | Single Line Text | `online`, `in_person` | Consult mode (online vs in-person) |

### Hold Tracking Fields (15-minute hold system)
| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `hold_appointment_id` | Single Line Text | GHL appointment ID | ID of the hold appointment (status: "new") |
| `hold_last_activity_at` | Single Line Text | ISO timestamp | Last inbound message timestamp (for hold expiry) |
| `hold_warning_sent` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether 10-minute warning was sent |

### Released Slot Fields (for re-hold feature)
| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `last_released_slot_display` | Single Line Text | Human-readable | Last slot that was released |
| `last_released_slot_start` | Single Line Text | ISO timestamp | Start time of released slot |
| `last_released_slot_end` | Single Line Text | ISO timestamp | End time of released slot |
| `last_released_slot_calendar` | Single Line Text | GHL calendar ID | Calendar ID of released slot |

### Reschedule Fields
| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `reschedule_pending` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether user is in reschedule flow |
| `reschedule_target_appointment_id` | Single Line Text | GHL appointment ID | Artist appointment being rescheduled |
| `reschedule_target_translator_appointment_id` | Single Line Text | GHL appointment ID | Translator appointment being rescheduled |

---

## 🎨 TATTOO QUALIFICATION FIELDS

| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `tattoo_title` | Single Line Text | Text | Tattoo title/name |
| `tattoo_summary` | Single Line Text | Text | Full tattoo description/summary |
| `tattoo_placement` | Single Line Text | Text (e.g., "right forearm", "left shoulder") | Where on body |
| `tattoo_style` | Single Line Text | Text (e.g., "realism", "black and gray", "traditional") | Tattoo style |
| `size_of_tattoo` | Single Line Text | Text (e.g., "7 inches", "half sleeve", "small") | Size description |
| `tattoo_color_preference` | Single Line Text | Text (e.g., "black and gray", "color", "minimal color") | Color preference |
| `how_soon_is_client_deciding` | Single Line Text | Text (e.g., "January", "second week of January", "next month") | Timeline for getting tattoo |
| `first_tattoo` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether this is their first tattoo |
| `tattoo_concerns` | Single Line Text | Text | Any concerns/questions about the tattoo |
| `tattoo_photo_description` | Single Line Text | Text | Description of reference photos uploaded |

---

## 👤 ARTIST & CLIENT FIELDS

| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `inquired_technician` | Single Line Text | `Joan`, `Andrew` | Artist preference from URL param or mention |
| `assigned_artist` | Single Line Text | `Joan`, `Andrew` | Currently assigned artist |
| `artist_assigned_at` | Single Line Text | ISO timestamp | When artist was assigned |
| `lead_spanish_comfortable` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether English lead is comfortable with Spanish |
| `returning_client` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether this is a returning client |
| `client_lifetime_value` | Single Line Text | Decimal number as text (e.g., `"150.00"`) | Total revenue from this client |
| `total_tattoos_completed` | Single Line Text | Integer as text (e.g., `"3"`) | Number of tattoos completed with this client |
| `whatsapp_user` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether contact uses WhatsApp |

---

## 📊 OPPORTUNITY PIPELINE FIELDS

| Field Name (GHL) | Type | Values/Format | Purpose |
|-----------------|------|---------------|---------|
| `opportunity_id` | Single Line Text | GHL opportunity ID | Linked opportunity ID |
| `opportunity_stage` | Single Line Text | `INTAKE`, `DISCOVERY`, `DEPOSIT_PENDING`, `QUALIFIED`, `CONSULT_APPOINTMENT`, `CONSULT_MESSAGE`, `TATTOO_BOOKED`, `COMPLETED`, `COLD_NURTURE_LOST` | Current pipeline stage |
| `tattoo_booked` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether tattoo appointment is booked |
| `tattoo_completed` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether tattoo is completed |
| `cold_nurture_lost` | Single Line Text | `true`/`false` or `Yes`/`No` (stored as text) | Whether lead was marked as lost in cold nurture |

---

## 🔧 SETUP INSTRUCTIONS

### Step 1: Create Fields in GHL
1. Go to **Settings → Custom Fields → Contacts**
2. Create each field listed above with the exact field name (case-sensitive)
3. **Set ALL fields as "Single Line Text" type** - this is the recommended approach

### Step 2: Important Notes
- **Field names must match exactly** (case-sensitive) - use lowercase with underscores
- **All fields should be "Single Line Text"** - the code handles boolean values stored as text
- **Boolean fields** (like `deposit_paid`, `consult_explained`) will store `"true"`/`"false"` or `"Yes"`/`"No"` as text - the `boolField()` helper reads these correctly
- **Dropdown-style fields** (like `ai_phase`, `consultation_type`) store values as text strings (`"intake"`, `"message"`, etc.)
- **Date fields** store ISO timestamp strings (`"2024-12-10T15:30:00.000Z"`) as text
- **Numeric fields** store numbers as text strings (`"100"`, `"5"`) - can be parsed when needed

### Step 3: Field Groups (Optional but Recommended)
Organize fields into groups:
- **AI System** (`ai_phase`, `lead_temperature`, `language_preference`, etc.)
- **Deposit & Payment** (`deposit_paid`, `deposit_link_sent`, etc.)
- **Booking** (`consultation_type`, `hold_appointment_id`, etc.)
- **Tattoo Details** (`tattoo_summary`, `tattoo_placement`, etc.)
- **Client Info** (`assigned_artist`, `returning_client`, etc.)

---

## ✅ QUICK CHECKLIST

**Critical Fields (Must Have):**
- [ ] `ai_phase`
- [ ] `lead_temperature`
- [ ] `deposit_paid`
- [ ] `deposit_link_sent`
- [ ] `consultation_type`
- [ ] `tattoo_summary`
- [ ] `tattoo_placement`
- [ ] `how_soon_is_client_deciding`

**Important Fields (Highly Recommended):**
- [ ] `hold_appointment_id`
- [ ] `hold_last_activity_at`
- [ ] `translator_needed`
- [ ] `assigned_artist`
- [ ] `language_preference`
- [ ] `consult_explained`
- [ ] `language_barrier_explained`
- [ ] `deposit_confirmation_sent`
- [ ] `reschedule_pending`
- [ ] `reschedule_target_appointment_id`

**Optional Fields (Nice to Have):**
- [ ] All other fields for full functionality

---

## 🐛 TROUBLESHOOTING

**If fields aren't being saved:**
1. Check field name spelling (must match exactly)
2. Verify field type matches recommendation
3. Check GHL API permissions for custom field write access

**If boolean values aren't working:**
- The code's `boolField()` helper handles `Yes`/`No`, `true`/`false`, `1`/`0` - any format works
- Values are stored as text strings in Single Line Text fields
- Code writes `true`/`false` (JavaScript booleans), but GHL stores them as text - this is fine!

**If dates aren't saving:**
- ISO timestamp format: `2024-12-10T15:30:00.000Z`
- Stored as text strings in Single Line Text fields
- Code writes ISO timestamp strings directly

**If dropdown-style values aren't working:**
- Values like `"intake"`, `"hot"`, `"message"` are stored as text strings
- Code writes these as strings directly - no special handling needed

