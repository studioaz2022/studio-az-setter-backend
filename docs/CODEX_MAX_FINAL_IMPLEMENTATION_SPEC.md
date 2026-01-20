# FINAL IMPLEMENTATION SPEC (Frozen) — Codex Max (Studio AZ AI Setter)
Version: `1.0` (Frozen)  
Date: `2025-12-15`  
Sources: `src/prompts/Render Logs (1).rtf` + chat analysis/notes  
Authority: This document is the only source of truth for implementation. If code, prompts, or prior docs conflict, this spec wins.

---

## 1) Product Goal (What “Good” Looks Like)
The system behaves like a top-performing human setter in DMs/SMS: it qualifies efficiently, avoids redundancy, answers what the lead just asked, and consistently guides the lead to a consultation and deposit without friction.

**Success criteria (must be measurable in logs):**
- Every outbound turn either (a) answers the lead’s question, (b) asks a single next-step question, or (c) provides concrete scheduling/deposit next steps.
- No “looping” questions (asking for consult mode after it’s chosen; asking “when” after a timeline is already known; re-explaining consult after it was explained).
- Any explicit request for scheduling (“what times”, “what days”, “openings”, “availability”) returns scheduling options immediately (or a scheduling fallback prompt), never a generic clarification prompt.
- Repetition is controlled: the system does not repeatedly restate the tattoo idea + placement after it has already been acknowledged and stored.

---

## 2) Canonical Case Study (Observed Failure Pattern from `Render Logs (1).rtf`)
This is the exact user-facing flow that must be prevented in Codex Max:

**Observed inbound lead messages (in order):**
1) “On my back towards my shoulder!”  
2) “I was thinking a bouquet of flowers!”  
3) “Not sure… second opinion on size… not too small not too big.”  
4) “The artist should help me figure it out!”  
5) “December!”  
6) “Video call!”  
7) “Yes that works!”  
8) “Video call this week! What times are you available?”  
9) “Yes!”  
10) “December”  
11) “What days do you have consultation openings for this week?”

**Observed UX breaks (must be fixed):**
- Repeatedly restating “bouquet + back shoulder” instead of progressing.
- After the lead asks for times/days, the system does not provide times/days.
- The system re-asks consult mode after the lead already chose video.
- A generic “clarify what you’re unsure about” message is sent in response to a scheduling question (because “what” triggers a broad “question override”).

---

## 3) UX SPEC (Message-Level Human Setter Expectations)

### 3.1. Universal Setter Rubric (every outbound message must pass)
- **Relevance:** First sentence must directly respond to the lead’s last message intent.
- **Progress:** Each turn must move exactly one step forward (qualification, consult choice, scheduling, deposit, confirmation).
- **Clarity:** Ask one question at the end unless you are providing explicit options that themselves demand a selection.
- **Brevity:** No filler. “Acknowledge → ask” beats “restate → restate → ask.”
- **Non-repetition rule:** Do not re-validate the same idea/placement repeatedly. If already captured, use short acknowledgments (“Perfect”, “Got it”, “Thanks”) and move on.

### 3.2. Canonical UX Stages (what a human setter does)
- **Stage A: Intake (core tattoo info)**  
  Goal: capture placement, concept, style (if relevant), size estimate, timing, references.  
  Output behavior: short acknowledgments + direct questions.
- **Stage B: Qualification (decision readiness + constraints)**  
  Goal: timing urgency, flexibility, consult readiness, language/communication preference, pain/concerns only if needed.  
  Output behavior: confirm timeline, introduce consult options with “why,” guide to consult choice.
- **Stage C: Consult Setup (path + scheduling)**  
  Goal: confirm consult path (video w/ translator vs messages), offer times immediately, lock a slot.  
  Output behavior: always provide times or a structured availability ask.
- **Stage D: Deposit (hold/lock)**  
  Goal: request/send deposit link at the right moment (after slot selection or alongside slot hold policy), confirm next steps.
- **Stage E: Confirmation/Handoff**  
  Goal: confirm consult booked, what to prepare, who they’ll meet, what happens next.

### 3.3. Message-by-Message Expectations (mapped to the case study)
1) Lead gives placement.  
   - Expected: acknowledge placement briefly + ask design concept.  
   - Must not: give long speeches.

2) Lead gives concept (“bouquet of flowers”).  
   - Expected: acknowledge once + ask size (with anchors).  
   - Must not: over-praise + repeat placement again unless needed.

3) Lead unsure on size, wants artist help.  
   - Expected: validate uncertainty + pivot to consult (because this is exactly what consult solves).  
   - Must not: re-ask “how big?” in a loop; don’t restate full concept again.

4) Lead confirms “artist should help.”  
   - Expected: ask timing (“when are you hoping to do it?”) OR if timing already known, go straight to consult setup.  
   - Must not: repeat the tattoo idea again.

5) Lead says “December.”  
   - Expected: confirm feasibility + move directly to consult options + explain the “why” behind options:  
     - “Artist’s native language is Spanish…”  
     - “Video consult uses translator; message consult stays in DMs…”  
     - Ask preference: “Which do you prefer?”  
   - Must not: provide options without context; must not end without a question.

6) Lead chooses “Video call!”  
   - Expected: confirm choice + (optionally) one-sentence translator reassurance + immediately offer times (or ask for availability windows).  
   - Must not: ask a standalone “Does that work?” and stop there (creates unnecessary extra turn).

7) Lead says “Yes that works!”  
   - Expected: treat as confirmation and immediately offer times.  
   - Must not: re-ask consult mode.

8) Lead asks: “What times are you available (this week)?”  
   - Expected: provide 2–3 concrete options in the lead’s timezone, then ask them to pick one.  
   - If scheduling tool is unavailable: ask structured constraints (“What day(s) this week and what time window?”).  
   - Must not: send translator explanation again; must not ask “what part should I explain?”

9–11) Any repeated scheduling asks (“what days… openings?”)  
   - Expected: always respond with times/days; if previously sent, resend a short reminder and ask them to choose.

### 3.4. UX Copy Rules (hard requirements)
- **No redundant restatements:** After `tattoo_summary` and `tattoo_placement` are known, the bot must not include both in the same sentence again unless the lead reintroduces them or asks for confirmation.
- **One-question rule:** Prefer one clear question per turn. If offering options, the question is “Which do you prefer?” or “Which one works?”.
- **Scheduling is sacred:** Any scheduling request must receive scheduling options, not meta-discussion.
- **Explain the “why” once:** Translator/language barrier explanation must happen before the user chooses (or immediately when they choose), and never repeat verbatim once recorded.
- **Always guide to the next action:** If the bot cannot complete the action (no slot data), it must ask for the minimum info needed to complete it.

---

## 4) SYSTEM SPEC (Phases, Flags, Gating Logic, and Why the UX Broke)

### 4.1. System State: Required Fields (CRM is source of truth)
All are GHL custom fields (single line text). Values are stored as text but treated as booleans where noted.

**Conversation phase**
- `ai_phase`: `intake` | `discovery` | `qualification` | `closing` | `consult_support` | `handoff` | `reengagement` | `objections` | `routing`
- `lead_temperature`: `hot` | `warm` | `cold` | `disqualified`

**Tattoo intake**
- `tattoo_placement` (string)
- `tattoo_summary` (string)
- `tattoo_size` (string) - canonical key for tattoo size
- `tattoo_style` (optional)
- `tattoo_color_preference` (optional)
- `how_soon_is_client_deciding` (string)

**Consult path and language barrier**
- `consultation_type`: `appointment` | `message` | `in_person` (optional)
- `translator_needed`: boolean-text
- `language_barrier_explained`: boolean-text (means explanation delivered, not necessarily “accepted”)
- `translator_confirmed`: boolean-text (**NEW REQUIRED FIELD**; stores whether lead accepted translator for video consult)

**Consult/deposit progress**
- `consult_explained`: boolean-text (must be set true whenever the system sends the consult/deposit explanation)
- `times_sent`: boolean-text
- `deposit_link_sent`: boolean-text
- `deposit_link_url`: string
- `deposit_paid`: boolean-text

**Anti-loop / memory**
- `last_sent_slots`: JSON string (array of last offered slots)
- `last_sent_messages`: JSON string (array of last messages, minimal window)
- `consultation_type_locked`: boolean-text (**NEW REQUIRED FIELD**; locks consult path unless lead explicitly switches)

### 4.2. Intent Taxonomy (what the system must detect)
- `slot_selection_intent`: lead picks a specific offered slot (“option 2”, “Tuesday at 5”, etc.)
- `reschedule_intent`: lead wants to move an existing appointment
- `deposit_intent`: asks to pay / asks for deposit link
- `scheduling_intent` (strong booking intent): asks for times/days/openings/availability
- `consult_path_choice_intent`: chooses video/call vs messages
- `process_question_intent`: asks “why/how/what is deposit/translator/consult”
- `price_question_intent`: asks price/quote/cost
- `intake_intent`: everything else (design/placement/size/style/timeline)

### 4.3. Handler Precedence (core system behavior)
Codex Max must process inbound messages in this order, with “first match wins,” but with explicit multi-intent handling:
1) `reschedule_intent`  
2) `slot_selection_intent`  
3) `deposit_intent`  
4) `scheduling_intent`  
5) `consult_path_choice_intent` (state update + optional message)  
6) `price_question_intent` (answer + progress)  
7) `process_question_intent` (answer + progress)  
8) AI-driven `intake_intent` conversation

**Multi-intent rule (mandatory):**  
If a message matches `scheduling_intent` AND `consult_path_choice_intent` (example: “Video call this week—what times?”), the system MUST:
- Set/update `consultation_type` appropriately (state update), AND
- Immediately execute the `scheduling_intent` response (offer times), AND
- MUST NOT send an intermediate “translator explanation” question that blocks times.

### 4.4. Why the UX Broke in the Observed Logs (root causes)
- **Misordered early-return logic:** A broad “question override” fires before scheduling intent, so scheduling questions (“what days…”) get a generic clarification reply.
- **Over-broad question detection:** Treating any message containing “what/how/why” as confusion is incorrect; scheduling questions contain “what” but are booking intent.
- **Consult path handler blocks scheduling:** Choosing “video/call” triggers a translator explanation message and returns early, preventing time offering even when the lead explicitly asks for openings.
- **Missing/unsynced lock flags:** If `consultation_type_locked` doesn’t exist or isn’t respected, the system re-triggers consult-path messaging repeatedly.
- **Consult explanation state not being recorded reliably:** If `consult_explained` is not set at the moment the explanation is sent, the AI/system repeats it.
- **Post-processing can remove the only “next step question”:** Bubble-limiting and trimming must not leave the user without a guided next action.

---

## 5) Final Implementation Requirements (Codex Max Behavior)

### 5.1. Scheduling Response Requirements (non-negotiable)
When `scheduling_intent` is detected, the system MUST do one of the following (in this priority order):
- **Offer concrete slots:** 2–3 options this week first (unless user specifies later), formatted consistently; end with “Which works best?”  
- **If no slots available:** offer next available week; end with selection question.  
- **If scheduling tool fails:** ask for structured availability: “Which day(s) and what time window (morning/afternoon/evening)?” and store it.

### 5.2. Translator/Language Barrier Requirements
- The system MUST explain the Spanish/translator constraint as “why this is easy” (trust-building), not as friction.
- If lead chooses video consult:
  - Set: `consultation_type=appointment`, `translator_needed=true`, `consultation_type_locked=true`
  - Send translator explanation inline, but MUST NOT block scheduling on a yes/no.
  - If the lead explicitly objects, then ask them to choose message consult instead.
- If the lead explicitly confirms translator (“yes that works”), set `translator_confirmed=true` and proceed directly to scheduling.

### 5.3. Consult Options (“why behind options”)
When the system first offers consult options (video vs messages), it MUST include the “why” in the same turn:
- “Artist’s native language is Spanish…”
- “Video consult includes translator…”
- “Messages works great too…”
- “Which do you prefer?”

### 5.4. Consult/Deposit Explanation State
- Whenever the system sends a consult + deposit explanation (templated or AI), it MUST set `consult_explained=true` immediately in the same handler.
- The system MUST NOT rely solely on AI meta flags to determine whether the consult was explained.

### 5.5. Anti-Repetition (implementation rules)
- Maintain `tattoo_summary` and `tattoo_placement` as facts; once present, treat them as “known.”
- Outbound message generation (AI or templated) MUST obey:
  - Do not repeat both idea and placement after they’re known.
  - If acknowledging, use short acknowledgments (“Perfect”, “Thanks”, “Got it”).
- Post-processing MUST ensure the final outbound message still contains a next-step question when one is required by state.

### 5.6. AI Boundary (what AI is allowed to do)
- AI is used for `intake_intent`/qualification conversation only.
- Scheduling, deposit link actions, slot selection, reschedule, and consult path locking are deterministic system responsibilities.

---

## 6) Acceptance Tests Checklist (must pass before release)

### A. Scheduling Questions
- A1: Input: “What times are you available this week?” → Output: 2–3 concrete time options + “Which works?”; MUST NOT send “what part should I explain?”; MUST set/update `times_sent=true`.
- A2: Input: “What days do you have consultation openings this week?” → Same as A1 (days + times).
- A3: If slots unavailable → Output offers next best window + selection question.

### B. Multi-intent (video + scheduling)
- B1: Input: “Video call this week—what times?” (no prior consult type) → MUST set `consultation_type=appointment`, `translator_needed=true`, `consultation_type_locked=true`, and MUST still offer times immediately.
- B2: Same input when consult type already set/locked → MUST NOT re-send translator explanation; MUST offer times.

### C. Translator Flow
- C1: After translator explanation, lead replies “Yes that works” → MUST set `translator_confirmed=true` and immediately offer times; MUST NOT ask consult mode again.
- C2: Lead replies “No” / “I don’t want a translator” → MUST offer message consult path and ask preference.

### D. Consult Options + “Why”
- D1: After timing is known (“December”), system offers consult options → MUST include why (Spanish/translator context) + ask preference.

### E. No-loop Guarantees
- E1: After `consultation_type=appointment` is set, system MUST NOT ask “video or messages?” unless the lead explicitly indicates switching (“actually”, “instead”, “rather”, “prefer messages”).
- E2: After `how_soon_is_client_deciding` is captured as “December”, system MUST NOT ask “When are you trying to get it done?” unless the lead changes it or ambiguity is detected.

### F. Post-processing Integrity
- F1: After bubble trimming/dedupe, if the state requires a question, the last outbound bubble MUST contain a next-step question (or an appended deterministic question must be added).
- F2: No outbound turn ends with only reassurance when a decision is required (consult preference, slot selection, availability window).

### G. Consult Explained Flag
- G1: When a consult/deposit explanation is sent (templated or AI), `consult_explained` MUST become true in the same turn; subsequent turns MUST NOT resend the full explanation.

