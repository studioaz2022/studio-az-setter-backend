# GHL API Endpoints Usage Analysis

This document analyzes which GHL API endpoints from `GHL_API_CALLS_DOCUMENTATION.md` are actively being used in the codebase.

## Summary

**Total Endpoints:** 33  
**Actively Used:** 31  
**Not Used:** 2

---

## ✅ ACTIVELY USED ENDPOINTS (31)

### Contact Management (9/9) ✅

1. **`getContact`** ✅
   - Used in: `app.js`, `artistRouter.js`, `bookingController.js`, `deterministicResponses.js`, `followupScheduler.js`, `opportunityManager.js`, `consultPathHandler.js`
   - Also used internally by `inferConversationMessageType`

2. **`lookupContactIdByEmailOrPhone`** ✅
   - Used in: `app.js` (webhook handlers)
   - Used internally by `upsertContactFromWidget`

3. **`createContact`** ✅
   - Used in: `app.js` (webhook handlers)
   - Used internally by `upsertContactFromWidget`

4. **`updateContact`** ✅
   - Used in: `bookingController.js`
   - Used internally by: `updateSystemFields`, `updateTattooFields`, `updateContactAssignedUser`, `upsertContactFromWidget`

5. **`upsertContactFromWidget`** ✅
   - Used in: `app.js` (widget submission endpoints)

6. **`updateSystemFields`** ✅
   - Used extensively in: `app.js`, `artistRouter.js`, `bookingController.js`, `controller.js`, `consultPathHandler.js`, `deterministicResponses.js`, `followupScheduler.js`, `holdLifecycle.js`, `opportunityManager.js`

7. **`updateTattooFields`** ✅
   - Used in: `app.js` (webhook handlers), `artistRouter.js`

8. **`updateContactAssignedUser`** ✅
   - Used in: `artistRouter.js`

9. **`createTaskForContact`** ✅
   - Used in: `consultPathHandler.js`

### Conversations & Messaging (4/4) ✅

10. **`findConversationForContact`** ✅
    - Used internally by: `sendConversationMessage`, `inferConversationMessageType`

11. **`getConversationHistory`** ✅
    - Used in: `app.js` (webhook handlers), `opportunityManager.js`

12. **`sendConversationMessage`** ✅
    - Used extensively in: `app.js`, `bookingController.js`, `consultPathHandler.js`, `controller.js`, `deterministicResponses.js`, `followupScheduler.js`, `holdLifecycle.js`

13. **`inferConversationMessageType`** ✅
    - Used internally by: `sendConversationMessage`

### Calendar & Appointments (6/6) ✅

14. **`createAppointment`** ✅
    - Used in: `bookingController.js`

15. **`listAppointmentsForContact`** ✅
    - Used in: `app.js` (appointment webhook), `bookingController.js`, `followupScheduler.js`
    - Used internally by: `getConsultAppointmentsForContact`

16. **`updateAppointmentStatus`** ✅
    - Used in: `app.js` (appointment webhook), `deterministicResponses.js`, `followupScheduler.js`, `holdLifecycle.js`

17. **`rescheduleAppointment`** ✅
    - Used in: `app.js` (appointment webhook)

18. **`getConsultAppointmentsForContact`** ✅
    - Used in: `bookingController.js`, `followupScheduler.js`

19. **`getCalendarFreeSlots`** ✅
    - Used in: `bookingController.js`

### Opportunities & CRM Pipeline (8/10) ⚠️

20. **`createOpportunity`** ❌ **NOT USED**
    - Exported but never imported or called
    - **Note:** Codebase uses `upsertOpportunity` instead

21. **`upsertOpportunity`** ✅
    - Used in: `opportunityManager.js`

22. **`updateOpportunity`** ✅
    - Used internally by: `updateOpportunityStage`, `updateOpportunityValue`, `closeOpportunity`
    - Used directly in: `opportunityManager.js`

23. **`updateOpportunityStage`** ✅
    - Used in: `opportunityManager.js`

24. **`updateOpportunityValue`** ✅
    - Used in: `opportunityManager.js`

25. **`closeOpportunity`** ❌ **NOT USED**
    - Exported but never imported or called
    - **Note:** Opportunities are updated but not explicitly closed via this function

26. **`addOpportunityNote`** ✅
    - Used in: `opportunityManager.js`

27. **`searchOpportunities`** ✅
    - Used in: `artistRouter.js`

28. **`getOpportunity`** ✅
    - Used in: `opportunityManager.js`

29. **`getOpportunitiesByContact`** ✅
    - Used in: `opportunityManager.js`

### File Uploads (1/1) ✅

30. **`uploadFilesToTattooCustomField`** ✅
    - Used in: `app.js` (form webhook handler)

### Contact Assignment & Followers (3/3) ✅

31. **`assignContactToArtist`** ✅
    - Used in: `app.js` (deposit paid webhook)

32. **`addFollowersToContact`** ✅
    - Used internally by: `addTranslatorAsFollower`

33. **`addTranslatorAsFollower`** ✅
    - Used in: `app.js` (consultation booking), `consultPathHandler.js`

---

## ❌ NOT ACTIVELY USED ENDPOINTS (2)

### 1. `createOpportunity` (Endpoint #20)

**Status:** Exported but never imported or called

**Reason:** The codebase uses `upsertOpportunity` instead, which handles both creating and updating opportunities in a single call.

**Recommendation:** 
- Keep for potential future use if explicit create-only behavior is needed
- Or remove if `upsertOpportunity` always suffices

**Location:** `src/clients/ghlOpportunityClient.js` lines 25-62

---

### 2. `closeOpportunity` (Endpoint #25)

**Status:** Exported but never imported or called

**Reason:** Opportunities are updated via `updateOpportunity` and `updateOpportunityStage`, but there's no explicit "close" operation being called.

**Recommendation:**
- Consider using this function when opportunities need to be marked as "won" or "lost"
- Or remove if status updates via `updateOpportunity` are sufficient

**Location:** `src/clients/ghlOpportunityClient.js` lines 134-138

---

## Internal/Helper Functions

These functions are not directly imported but are used internally by other exported functions:

- `findConversationForContact` - Used by `sendConversationMessage` and `inferConversationMessageType`
- `inferConversationMessageType` - Used by `sendConversationMessage`
- `createContact` / `updateContact` - Used by `upsertContactFromWidget`
- `lookupContactIdByEmailOrPhone` - Used by `upsertContactFromWidget`
- `updateContact` - Used by `updateSystemFields`, `updateTattooFields`, `updateContactAssignedUser`
- `addFollowersToContact` - Used by `addTranslatorAsFollower`
- `listAppointmentsForContact` - Used by `getConsultAppointmentsForContact`
- `updateOpportunity` - Used by `updateOpportunityStage`, `updateOpportunityValue`, `closeOpportunity`

---

## Usage Statistics by Category

| Category | Total | Used | Unused | Usage % |
|----------|-------|------|--------|---------|
| Contact Management | 9 | 9 | 0 | 100% |
| Conversations & Messaging | 4 | 4 | 0 | 100% |
| Calendar & Appointments | 6 | 6 | 0 | 100% |
| Opportunities & CRM Pipeline | 10 | 8 | 2 | 80% |
| File Uploads | 1 | 1 | 0 | 100% |
| Contact Assignment & Followers | 3 | 3 | 0 | 100% |
| **TOTAL** | **33** | **31** | **2** | **94%** |

---

## Recommendations

1. **Consider removing unused functions** (`createOpportunity`, `closeOpportunity`) if they're not needed, or document why they're kept for future use.

2. **Consider using `closeOpportunity`** in `opportunityManager.js` when opportunities are marked as "won" or "lost" for better code clarity.

3. **All other endpoints are actively used** and should be maintained.

