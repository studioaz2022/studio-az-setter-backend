# AI Setter Project Status & Roadmap

## Executive Summary

This document maps the current implementation status of the Studio AZ AI Setter system and outlines what remains to be built. The system is a Node.js/Express backend that integrates with GoHighLevel (GHL) CRM and Square payments to automate tattoo lead qualification and consultation booking.

**Current Status:** Core messaging and deposit flow are functional. The system can handle inbound messages, generate AI responses, create deposit links, and update CRM fields. Missing: automated follow-ups, artist routing, booking automation, and form webhook opener delivery.

## Implementation Phases

### ✅ PHASE 1: Foundation & Core Messaging

**Status:** ✅ COMPLETE (100%)

**What's Working:**

- ✅ Express backend server (`index.js`)
- ✅ GHL API integration (`ghlClient.js`)
  - Contact CRUD operations
  - Custom field mapping (`CUSTOM_FIELD_MAP`, `SYSTEM_FIELD_MAP`)
  - System field updates (`updateSystemFields`)
  - Tattoo field updates (`updateTattooFields`)
  - File uploads to custom fields (`uploadFilesToTattooCustomField`)
  - Conversation message sending (`sendConversationMessage`)
  - Tag normalization
- ✅ OpenAI AI client (`src/ai/aiClient.js`)
  - GPT-4 integration
  - Prompt loading system
  - Language detection (`detectLanguage()`)
  - Phase-aware message building
  - Meta flags extraction (`wantsDepositLink`, `depositPushedThisTurn`, etc.)
  - Field updates extraction (`field_updates` object)
- ✅ State machine (`src/ai/stateMachine.js`)
  - Lead temperature logic (`decideLeadTemperature()`)
  - Initial phase assignment (`initialPhaseForNewIntake()`)
  - Phase transitions (`decidePhaseForMessage()`)
- ✅ Message webhook handler (`/ghl/message-webhook`)
  - Processes inbound messages from SMS, IG DM, FB DM
  - Detects language and updates `language_preference`
  - Generates AI responses
  - Sends replies back to correct channel/thread
  - Updates system fields (`ai_phase`, `lead_temperature`)
  - Applies field updates from AI responses
- ✅ Language detection
  - Auto-detects Spanish from message content
  - Updates `language_preference` custom field
  - Spanish DM defaults to Spanish
  - No language mixing unless user does
- ✅ Square payment client (`src/payments/squareClient.js`)
  - Payment link creation (`createDepositLinkForContact()`)
  - Order-to-contact mapping (`getContactIdFromOrder()`)
  - Sandbox/production support
- ✅ Square webhook handler (`/square/webhook`)
  - Signature verification
  - Updates GHL when deposit paid
  - Sets `deposit_paid: true` system field
- ✅ Lead endpoints (`/lead/partial`, `/lead/final`)
  - Widget form submissions
  - File uploads
  - Custom field mapping

**What's Missing:**

- ⚠️ Prompt version mismatch: Code uses `master_system_prompt_a.txt` and `phase_prompts_b.txt`, but v3 versions exist (`master_system_prompt_v3.txt`, `phase_prompts_v3.txt`)
- ⚠️ Form webhook opener: Generates AI opener but only logs it (doesn't send message)

**Next Steps:**

1. Update `aiClient.js` to use v3 prompts via `promptsIndex.js`
2. Enable form webhook to send opener messages via `sendConversationMessage()`

---

### ⚠️ PHASE 2: Lead Qualification & Discovery

**Status:** ⚠️ PARTIALLY COMPLETE (~70%)

**What's Working:**

- ✅ Discovery phase prompts exist (`phase_prompts_v3.txt`)
  - Intake phase guidance
  - Discovery phase guidance
  - Qualification phase guidance
  - Closing phase guidance
  - Objections handling guidance
- ✅ AI can extract field updates from conversations
  - `tattoo_placement`
  - `tattoo_size`
  - `tattoo_style`
  - `tattoo_color_preference`
  - `how_soon_is_client_deciding`
  - `first_tattoo`
  - `tattoo_concerns`
  - `tattoo_summary`
- ✅ Field updates automatically applied to GHL (`updateTattooFields()`)
- ✅ AI receives `contactProfile` to check existing fields before asking
- ✅ AI phase transitions working (`intake` → `discovery` → `qualification` → `closing`)
- ✅ Lead temperature tracking (`hot`, `warm`, `cold`)
- ✅ AI handles incomplete intake via prompts

**What's Missing:**

- ⚠️ No structured discovery branching logic in code (relies entirely on AI prompts)
- ⚠️ No validation that required fields are collected before moving phases
- ⚠️ No explicit incomplete intake detection logic (handled by prompts only)
- ✅ Returning client detection + fast-path handling (tags/system fields/past appointments) added
- ✅ Returning client fast-path behavior (skip newbie education, quicker booking) added

**Next Steps:**

1. Add discovery state machine to track which fields are collected
2. Add validation before phase transitions
3. Continue refining returning client UX (e.g., artist preference reuse, expedited slot surfacing)
4. Add return client logic (skip questions, faster routing)  ✅ baseline shipped; keep iterating on edge cases

---

### ⚠️ PHASE 3: Deposit & Payment Flow

**Status:** ⚠️ PARTIALLY COMPLETE (~75%)

**What's Working:**

- ✅ Deposit link creation (`createDepositLinkForContact()`)
- ✅ AI can request deposit link via `wantsDepositLink: true` meta flag
- ✅ Deposit link automatically sent when AI requests it
- ✅ Square webhook updates GHL when deposit paid
- ✅ System fields updated: `deposit_link_sent`, `deposit_paid`
- ✅ Prevents duplicate deposit links (checks before creating)
- ✅ Decoy offer logic exists in prompts (`$50 consult fee` fallback)
- ✅ Refund logic explained in prompts
- ✅ Deposit-before-consult logic in prompts

**What's Missing:**

- ⚠️ **CRITICAL:** Deposit amount hardcoded to $50 (5000 cents) instead of $100 (10000 cents)
- ⚠️ Pipeline stage update commented out (line 215 in `index.js`)
- ⚠️ No automatic escalation when deposit paid (should move to handoff phase)
- ⚠️ Deposit-before-consult not enforced in code (only in prompts)
- ❌ No notification to AI setter when deposit paid
- ❌ No automatic phase transition to `handoff` when deposit paid

**Next Steps:**

1. **URGENT:** Change default deposit amount from $50 to $100 in `index.js` (line 755) and `squareClient.js`
2. Enable pipeline stage update when deposit paid
3. Add automatic phase transition to `handoff` when `deposit_paid: true`
4. Add notification/trigger for AI setter when deposit paid
5. Add code-level enforcement of deposit-before-consult logic

---

### ❌ PHASE 4: Automation & Follow-ups

**Status:** ❌ NOT STARTED (0%)

**What's Missing:**

- ❌ No follow-up scheduler (`followupScheduler.js` doesn't exist)
- ❌ No automated cadence system
- ❌ No time-based message scheduling
- ❌ No follow-up logic based on lead temperature
- ❌ No automatic follow-up stop when deposit paid
- ❌ No spam detection avoidance logic
- ⚠️ Follow-up prompts exist in `phase_prompts_v3.txt` (reengagement phase) but no automation

**Planned Features:**

- Day 1: 2-3 nudges (if deposit link sent but not paid)
- Days 2-3: 1-2 per day
- Days 4-7: 1 per day
- Weekly after that
- Cold leads → longer nurture (7-30 days)
- Warm leads → "Just checking in" every 2-3 days
- Hot leads → rapid short nudges
- Follow-up stops automatically after deposit

**Next Steps:**

1. Create `src/ai/followupScheduler.js`
2. Add scheduled job system (cron or queue)
3. Implement cadence logic based on lead temperature
4. Add follow-up message generation
5. Integrate with GHL to send scheduled messages
6. Add follow-up stop logic when deposit paid

---

### ❌ PHASE 5: Artist Assignment & Handoff

**Status:** ❌ NOT STARTED (0%)

**What's Missing:**

- ❌ No artist routing logic
- ❌ No style-based assignment (realism → Joan, etc.)
- ❌ No workload balancing
- ❌ No URL parameter override (`?tech=Joan`)
- ❌ No three-way conversation creation (AI Setter + Artist + Lead)
- ❌ No artist tone matching
- ❌ No handoff phase automation
- ⚠️ `inquired_technician` custom field exists but not used

**Planned Features:**

- Style-based routing:
  - Realism → Joan
  - Fine line → [Artist]
  - Traditional → [Artist]
  - etc.
- Workload balancing (assign based on current load)
- URL parameter override (`?tech=Joan` tag)
- Assignment happens AFTER deposit paid
- Three-way conversation creation
- AI stays in thread but only responds to FAQs, scheduling, admin questions
- AI matches artist tone (punctuation, style)

**Next Steps:**

1. Create `src/ai/artistRouter.js`
2. Define artist styles and mappings
3. Implement style-based routing logic
4. Add workload balancing
5. Add URL parameter parsing
6. Create GHL three-way conversation API integration
7. Add artist tone matching in prompts
8. Implement handoff phase automation

---

### ❌ PHASE 6: Booking & Scheduling

**Status:** ❌ NOT STARTED (0%)

**What's Missing:**

- ❌ No GHL appointment booking API integration
- ❌ No calendar/time retrieval
- ❌ No automated appointment creation
- ❌ No time slot offering (2-3 options Hormozi style)
- ❌ No opportunity stage updates for appointments
- ❌ No translator option logic (English lead + Spanish artist)

**Planned Features:**

- AI books consultation directly using GHL API
- Retrieve available times from GHL calendar
- Offer 2-3 time options (Hormozi style)
- Create appointment automatically
- Update opportunity stage to "Consultation Booked"
- If English lead & Spanish artist → include translator option

**Next Steps:**

1. Research GHL appointment booking API
2. Create `src/clients/ghlAppointments.js`
3. Implement calendar/time retrieval
4. Add time slot offering logic
5. Add automated appointment creation
6. Add opportunity stage updates
7. Add translator option logic

---

### ❌ PHASE 7: Advanced Features

**Status:** ❌ NOT STARTED (0%)

**What's Missing:**

- ❌ No data feedback loop
- ❌ No conversion tracking
- ❌ No objection handling pattern analysis
- ❌ No learning system
- ❌ No A/B testing for messages
- ❌ No performance analytics

**Planned Features:**

- Collect successful closes
- Analyze objection handling patterns
- Learn which message bubbles convert best
- Improve AI setter via closure history
- "Experience replay" from successful tattoos
- Long-term: AI begins to speak like the artist (healed tattoo knowledge, style language)

**Next Steps:**

1. Design feedback collection system
2. Create analytics database/storage
3. Implement conversion tracking
4. Add objection pattern analysis
5. Build learning/improvement loop
6. Add A/B testing framework

---

## Current Architecture

### File Structure

```
studio-az-setter-backend/
├── index.js                    # Main Express server (root level)
├── ghlClient.js                # GHL API client (root level)
├── package.json
├── .env                        # Environment variables
└── src/
    ├── ai/
    │   ├── aiClient.js         # OpenAI integration
    │   ├── controller.js       # AI message controller
    │   └── stateMachine.js     # Phase/temperature logic
    ├── payments/
    │   ├── squareClient.js     # Square payment integration
    │   └── index.js
    └── prompts/
        ├── master_system_prompt_a.txt      # OLD (not used)
        ├── master_system_prompt_v3.txt     # CURRENT (not loaded)
        ├── phase_prompts_b.txt              # OLD (not used)
        ├── phase_prompts_v3.txt             # CURRENT (not loaded)
        └── promptsIndex.js                  # Loads v3 prompts (not used)
```

### Key Integrations

**GoHighLevel (GHL):**
- Form webhook (`/ghl/form-webhook`)
- Message webhook (`/ghl/message-webhook`)
- Contact CRUD operations
- Custom field updates
- Conversation message sending
- File uploads

**Square:**
- Payment link creation
- Webhook handler (`/square/webhook`)
- Order-to-contact mapping

**OpenAI:**
- GPT-4 chat completions
- Structured JSON responses
- Phase-aware prompts
- Language detection

---

## Critical Issues & Fixes Needed

### 🔴 High Priority (Blocking/Incorrect)

1. **Deposit Amount Wrong**
   - **Issue:** Hardcoded to $50 instead of $100
   - **Location:** `index.js` line 755, `squareClient.js`
   - **Fix:** Change `amountCents: 5000` to `amountCents: 10000`

2. **Prompt Version Mismatch**
   - **Issue:** Code uses old prompts (`master_system_prompt_a.txt`, `phase_prompts_b.txt`) but v3 exists
   - **Location:** `src/ai/aiClient.js`
   - **Fix:** Update to use `promptsIndex.js` which loads v3 prompts

3. **Form Webhook Opener Not Sending**
   - **Issue:** Generates opener but only logs it
   - **Location:** `index.js` lines 369-374
   - **Fix:** Call `sendConversationMessage()` after generating opener

### 🟡 Medium Priority (Important Features)

4. **No Pipeline Stage Updates**
   - **Issue:** Pipeline stage update commented out when deposit paid
   - **Location:** `index.js` line 215
   - **Fix:** Uncomment and implement pipeline stage update

5. **No Automatic Phase Transition on Deposit**
   - **Issue:** Should move to `handoff` phase when deposit paid
   - **Location:** `index.js` Square webhook handler
   - **Fix:** Add phase transition logic

6. **No Follow-up Automation**
   - **Issue:** Follow-ups exist in prompts but no automation
   - **Fix:** Implement Phase 4 (Automation & Follow-ups)

### 🟢 Low Priority (Nice to Have)

7. **No Constants File**
   - **Issue:** Magic strings scattered throughout code
   - **Fix:** Create `src/config/constants.js`

8. **No Structured Logging**
   - **Issue:** Using `console.log` everywhere
   - **Fix:** Create `src/utils/logger.js`

9. **No Error Handling Middleware**
   - **Issue:** Error handling scattered
   - **Fix:** Add Express error middleware

---

## Implementation Roadmap

### Immediate (This Week)

1. ✅ Fix deposit amount ($50 → $100)
2. ✅ Update prompts to v3
3. ✅ Enable form webhook opener sending
4. ✅ Add pipeline stage update on deposit paid
5. ✅ Add automatic phase transition to `handoff` on deposit paid

### Short-term (Next 2-4 Weeks)

1. Implement follow-up scheduler (Phase 4)
2. Add return client detection (Phase 2)
3. Implement artist routing (Phase 5)
4. Add discovery state machine validation (Phase 2)

### Medium-term (Next 1-3 Months)

1. Implement booking automation (Phase 6)
2. Add artist handoff and three-way conversations (Phase 5)
3. Create constants file and structured logging
4. Add error handling middleware

### Long-term (3+ Months)

1. Implement data feedback loop (Phase 7)
2. Add learning system
3. Build analytics dashboard
4. A/B testing framework

---

## Success Metrics

### Current Capabilities

- ✅ Can receive and respond to messages across SMS, IG DM, FB DM
- ✅ Can generate context-aware AI responses
- ✅ Can create and send deposit payment links
- ✅ Can update CRM fields from conversations
- ✅ Can track lead temperature and AI phase
- ✅ Can handle multilingual conversations (English/Spanish)

### Target Capabilities (When Complete)

- ⏳ Automated follow-up cadence based on lead temperature
- ⏳ Style-based artist routing after deposit
- ⏳ Automated consultation booking
- ⏳ Return client detection and fast-track routing
- ⏳ Conversion tracking and analytics
- ⏳ Learning system for continuous improvement

---

## Notes

- The system is production-ready for basic lead qualification and messaging
- Core infrastructure is solid and well-architected
- Main gaps are in automation (follow-ups, routing, booking)
- Prompt system is sophisticated but needs to be updated to v3
- Deposit flow works but has incorrect default amount
