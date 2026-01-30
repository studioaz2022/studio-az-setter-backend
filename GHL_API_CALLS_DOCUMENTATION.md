# GHL (GoHighLevel) API Calls Documentation

This document lists all API calls made to GoHighLevel (GHL) in this workspace, including their functions, implementation details, and variables used.

## Table of Contents
- [Contact Management (v1 API)](#contact-management-v1-api)
- [Conversations & Messaging](#conversations--messaging)
- [Calendar & Appointments](#calendar--appointments)
- [Opportunities & CRM Pipeline](#opportunities--crm-pipeline)
- [File Uploads](#file-uploads)
- [Contact Assignment & Followers (v2 API)](#contact-assignment--followers-v2-api)

---

## Contact Management (v1 API)

**Base URL:** `https://rest.gohighlevel.com`  
**Client File:** `src/clients/ghlClient.js`

**⚠️ Note:** Most v1 API endpoints are still functional, but task creation has been migrated to v2 API. See test results below.

### 1. Get Contact by ID

**Function:** `getContact(contactId)`

**Endpoint:**
```
GET https://rest.gohighlevel.com/v1/contacts/{contactId}
```

**Headers:**
- `Authorization: Bearer ${process.env.GHL_API_KEY}`
- `Accept: application/json`

**Parameters:**
- `contactId` (string, required) - The contact ID to fetch

**Returns:**
- Contact object (handles both `{ contact: {...} }` and `{...}` response formats)

**Code Location:** Lines 105-133

**Variables Used:**
- `contactId` - Contact identifier
- `process.env.GHL_API_KEY` - API authentication token

---

### 2. Lookup Contact by Email or Phone

**Function:** `lookupContactIdByEmailOrPhone(email, phone)`

**Endpoint:**
```
GET https://rest.gohighlevel.com/v1/contacts/lookup?email={email}
GET https://rest.gohighlevel.com/v1/contacts/lookup?phone={phone}
```

**Headers:**
- `Authorization: Bearer ${process.env.GHL_API_KEY}` (via axios client)
- `Content-Type: application/json`

**Parameters:**
- `email` (string, optional) - Email address to search
- `phone` (string, optional) - Phone number to search

**Returns:**
- Contact ID string (extracts from `contacts[0].id`, `contact.id`, or `id`)

**Code Location:** Lines 193-245

**Variables Used:**
- `email` - Email address for lookup
- `phone` - Phone number for lookup
- `ghl` - Axios client instance (configured with base URL and auth)

---

### 3. Create Contact

**Function:** `createContact(body)`

**Endpoint:**
```
POST https://rest.gohighlevel.com/v1/contacts/
```

**Headers:**
- `Authorization: Bearer ${process.env.GHL_API_KEY}` (via axios client)
- `Content-Type: application/json`

**Parameters:**
- `body` (object, required) - Contact data object containing:
  - `firstName` (string)
  - `lastName` (string)
  - `email` (string)
  - `phone` (string)
  - `tags` (array)
  - `customField` (object)
  - `source` (string)

**Returns:**
- Created contact object

**Code Location:** Lines 247-250

**Variables Used:**
- `body` - Contact payload object
- `ghl` - Axios client instance

---

### 4. Update Contact

**Function:** `updateContact(contactId, body)`

**Endpoint:**
```
PUT https://rest.gohighlevel.com/v1/contacts/{contactId}
```

**Headers:**
- `Authorization: Bearer ${process.env.GHL_API_KEY}` (via axios client)
- `Content-Type: application/json`

**Parameters:**
- `contactId` (string, required) - Contact ID to update
- `body` (object, required) - Fields to update

**Returns:**
- Updated contact object

**Code Location:** Lines 252-255

**Variables Used:**
- `contactId` - Contact identifier
- `body` - Update payload object
- `ghl` - Axios client instance

---

### 5. Upsert Contact from Widget

**Function:** `upsertContactFromWidget(widgetPayload, mode = "partial")`

**Description:** Creates or updates a contact from widget data. Handles tag normalization and custom field mapping.

**Endpoint:** Uses `lookupContactIdByEmailOrPhone`, then `createContact` or `updateContact`

**Parameters:**
- `widgetPayload` (object, required) - Widget submission data:
  - `firstName` (string)
  - `lastName` (string)
  - `email` (string)
  - `phone` (string)
  - `tags` (array)
  - `customFields` (object)
  - `utm` (object)
- `mode` (string, optional) - `"partial"` or `"final"` (controls consultation tag)

**Returns:**
- `{ contactId, contact }` - Contact ID and contact object

**Code Location:** Lines 308-354

**Variables Used:**
- `widgetPayload` - Widget submission data
- `mode` - Submission mode ("partial" or "final")
- `normalizedTags` - Processed tags array
- `customField` - Mapped custom fields object
- `contactBody` - Formatted contact payload

**Helper Functions:**
- `normalizeTags()` - Normalizes tags and controls "consultation request" tag
- `mapCustomFields()` - Maps widget field keys to GHL custom field IDs

---

### 6. Update System Fields

**Function:** `updateSystemFields(contactId, fields = {})`

**Description:** Updates AI/system custom fields on a contact (phase, temperature, deposit status, etc.)

**Endpoint:** Uses `updateContact()`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `fields` (object, optional) - System fields to update:
  - `ai_phase` (string)
  - `lead_temperature` (string)
  - `deposit_link_sent` (boolean)
  - `deposit_paid` (boolean)
  - `last_phase_update_at` (string, ISO)

**Returns:**
- Updated contact object or null

**Code Location:** Lines 368-406

**Variables Used:**
- `contactId` - Contact identifier
- `fields` - System fields object
- `customField` - Mapped custom fields object
- `SYSTEM_FIELD_MAP` - Mapping from field names to GHL field IDs

---

### 7. Update Tattoo Fields

**Function:** `updateTattooFields(contactId, fields = {})`

**Description:** Updates tattoo-related custom fields using CUSTOM_FIELD_MAP

**Endpoint:** Uses `updateContact()`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `fields` (object, optional) - Tattoo fields:
  - `tattoo_placement` (string)
  - `tattoo_size` (string)
  - `tattoo_style` (string)
  - `tattoo_color_preference` (string)
  - `first_tattoo` (boolean/string) - Special handling for Yes/No conversion
  - Other fields from `CUSTOM_FIELD_MAP`

**Returns:**
- Updated contact object or null

**Code Location:** Lines 414-474

**Variables Used:**
- `contactId` - Contact identifier
- `fields` - Tattoo fields object
- `customField` - Mapped custom fields object
- `CUSTOM_FIELD_MAP` - Mapping from friendly keys to GHL field IDs

---

### 8. Update Contact Assigned User

**Function:** `updateContactAssignedUser(contactId, assignedUserId)`

**Description:** Updates the CRM owner (assigned user) for a contact

**Endpoint:** Uses `updateContact()`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `assignedUserId` (string, required) - User ID to assign

**Returns:**
- Updated contact object or null

**Code Location:** Lines 280-301

**Variables Used:**
- `contactId` - Contact identifier
- `assignedUserId` - User ID to assign

---

### 9. Create Task for Contact

**Function:** `createTaskForContact(contactId, task = {})`

**⚠️ MIGRATED TO V2 API** - This function now uses the v2 API endpoint.

**Endpoint:**
```
POST https://services.leadconnectorhq.com/contacts/{contactId}/tasks
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Content-Type: application/json`
- `Accept: application/json`
- `Version: 2021-07-28` (Required for v2 API)

**Parameters:**
- `contactId` (string, required) - Contact ID
- `task` (object, optional) - Task data:
  - `title` (string, default: "Consultation follow-up")
  - `body` (string, default: "") - Note: v2 API uses `body` instead of `description`
  - `description` (string) - Also accepted, mapped to `body`
  - `dueDate` (string, ISO) - Auto-set to tomorrow if not provided
  - `completed` (boolean, default: false) - Note: v2 API uses boolean `completed` instead of `status`
  - `assignedTo` (string, default: null)

**Payload Structure:**
```javascript
{
  title: string,
  body: string,
  dueDate: string, // ISO format, required
  completed: boolean, // false = incomplete, true = completed
  assignedTo: string | null
}
```

**Returns:**
- Created task object

**Code Location:** Lines 262-274 (updated to use v2 API)

**Variables Used:**
- `contactId` - Contact identifier
- `task` - Task payload object
- `payload` - Formatted task data with v2 API format
- `GHL_FILE_UPLOAD_TOKEN` - API token for v2 API
- `dueDate` - Auto-calculated if not provided

**Migration Notes:**
- **Previous v1 API:** Used `status: "open"` (string) - This endpoint was failing with 422 errors
- **Current v2 API:** Uses `completed: false` (boolean) - Successfully tested and working
- The v1 API endpoint `/v1/contacts/{contactId}/tasks` appears to be deprecated or has different requirements

---

## Conversations & Messaging

**Base URL:** `https://services.leadconnectorhq.com`  
**Client File:** `src/clients/ghlClient.js`

### 10. Find Conversation for Contact

**Function:** `findConversationForContact(contactId, { preferDm = false, typeFilter = null } = {})`

**Endpoint:**
```
GET https://services.leadconnectorhq.com/conversations/search?locationId={locationId}&contactId={contactId}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Version: 2021-04-15`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `preferDm` (boolean, optional) - Prioritize DM conversations over SMS
- `typeFilter` (string, optional) - `"DM"` or `"SMS"` to filter by type

**Returns:**
- Conversation object or null

**Code Location:** Lines 480-556

**Variables Used:**
- `contactId` - Contact identifier
- `preferDm` - Preference flag
- `typeFilter` - Type filter string
- `GHL_LOCATION_ID` - Location ID from environment
- `GHL_FILE_UPLOAD_TOKEN` - API token

---

### 11. Get Conversation History

**Function:** `getConversationHistory(contactId, { limit = 50, channel = null, sortOrder = "desc" } = {})`

**Endpoint:**
```
GET https://services.leadconnectorhq.com/conversations/messages/export?locationId={locationId}&contactId={contactId}&limit={limit}&sortBy=createdAt&sortOrder={sortOrder}&channel={channel}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Version: 2021-04-15`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `limit` (number, optional, default: 50, max: 500) - Number of messages to fetch
- `channel` (string, optional) - Filter by channel: "SMS", "Instagram", "Facebook", "WhatsApp", "Email"
- `sortOrder` (string, optional) - `"desc"` (newest first) or `"asc"` (oldest first)

**Returns:**
- Array of message objects with `direction`, `body`, `attachments`, `dateAdded`, `source`

**Code Location:** Lines 569-615

**Variables Used:**
- `contactId` - Contact identifier
- `limit` - Message limit
- `channel` - Channel filter
- `sortOrder` - Sort order
- `GHL_LOCATION_ID` - Location ID
- `GHL_FILE_UPLOAD_TOKEN` - API token

---

### 12. Send Conversation Message

**Function:** `sendConversationMessage({ contactId, body, channelContext = {} })`

**Description:** Sends a message via GHL conversations API. Handles both DM (Facebook/Instagram) and SMS/WhatsApp paths.

**Endpoint:**
```
POST https://services.leadconnectorhq.com/conversations/messages
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Content-Type: application/json`
- `Accept: application/json`
- `Version: 2021-07-28`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `body` (string, required) - Message text
- `channelContext` (object, optional) - Channel context:
  - `isDm` (boolean) - Whether this is a DM message
  - `hasPhone` (boolean) - Whether contact has phone number
  - `conversationId` (string) - Existing conversation ID
  - `phone` (string) - Phone number
  - `isWhatsApp` (boolean) - Whether to use WhatsApp

**Payload Structure:**
```javascript
{
  conversationId: string, // Optional, for existing conversations
  contactId: string,
  locationId: string, // Required if no conversationId
  message: string,
  type: string // "SMS", "FB", "IG", "WhatsApp", etc.
}
```

**Returns:**
- API response data

**Code Location:** Lines 758-1046

**Variables Used:**
- `contactId` - Contact identifier
- `body` - Message text
- `channelContext` - Channel context object
- `isDm` - DM flag
- `hasPhone` - Phone availability flag
- `conversationId` - Conversation ID
- `phone` - Phone number
- `isWhatsApp` - WhatsApp flag
- `GHL_LOCATION_ID` - Location ID
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `dmType` - Inferred DM type ("IG" or "FB")
- `finalConversationId` - Resolved conversation ID
- `foundConversation` - Found conversation object
- `type` - Message type string

**Helper Functions:**
- `inferConversationMessageType()` - Infers message type from contact/conversation data
- `findConversationForContact()` - Finds existing conversation

---

### 13. Infer Conversation Message Type

**Function:** `inferConversationMessageType(contactId, { preferDm = false } = {})`

**Description:** Infers the outbound message type by examining contact data and conversation history.

**Endpoint:** Uses `getContact()` and `findConversationForContact()`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `preferDm` (boolean, optional) - Prefer DM types when checking contact

**Returns:**
- Message type string: `"SMS"`, `"IG"`, `"FB"`, `"WhatsApp"`, `"GMB"`, `"Live_Chat"`, `"Email"`

**Code Location:** Lines 620-755

**Variables Used:**
- `contactId` - Contact identifier
- `preferDm` - DM preference flag
- `contact` - Contact object
- `conversation` - Conversation object
- `lastType` - Last message type from conversation

---

## Calendar & Appointments

**Base URL:** `https://services.leadconnectorhq.com`  
**Client File:** `src/clients/ghlCalendarClient.js`

### 14. Create Appointment

**Function:** `createAppointment({ calendarId, contactId, locationId, startTime, endTime, title, description, appointmentStatus, assignedUserId, address, meetingLocationType, meetingLocationId, ignoreDateRange, ignoreFreeSlotValidation })`

**Endpoint:**
```
POST https://services.leadconnectorhq.com/calendars/events/appointments
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-04-15`

**Parameters:**
- `calendarId` (string, required) - Calendar ID
- `contactId` (string, required) - Contact ID
- `locationId` (string, optional, default: `GHL_LOCATION_ID`) - Location ID
- `startTime` (string, required) - ISO datetime string
- `endTime` (string, required) - ISO datetime string
- `title` (string, optional) - Appointment title (default: "Consultation")
- `description` (string, optional) - Appointment description/notes
- `appointmentStatus` (string, optional) - Status: "new", "confirmed", "cancelled" (default: "new")
- `assignedUserId` (string, optional) - User ID to assign
- `address` (string, optional) - Meeting address (default: "Zoom")
- `meetingLocationType` (string, optional) - Location type (default: "custom")
- `meetingLocationId` (string, optional) - Location ID (default: "custom_0")
- `ignoreDateRange` (boolean, optional) - Ignore date range validation (default: false)
- `ignoreFreeSlotValidation` (boolean, optional) - Ignore free slot validation (default: true)

**Payload Structure:**
```javascript
{
  title: string,
  meetingLocationType: string,
  meetingLocationId: string,
  overrideLocationConfig: true,
  appointmentStatus: string,
  description: string,
  address: string,
  ignoreDateRange: boolean,
  toNotify: false,
  ignoreFreeSlotValidation: boolean,
  calendarId: string,
  locationId: string,
  contactId: string,
  startTime: string,
  endTime: string,
  assignedUserId: string // Optional
}
```

**Returns:**
- Created appointment object

**Code Location:** Lines 47-119

**Variables Used:**
- `calendarId` - Calendar identifier
- `contactId` - Contact identifier
- `locationId` - Location identifier
- `startTime` - Start datetime (ISO)
- `endTime` - End datetime (ISO)
- `title` - Appointment title
- `description` - Appointment description
- `appointmentStatus` - Status string
- `assignedUserId` - Assigned user ID
- `address` - Meeting address
- `meetingLocationType` - Location type
- `meetingLocationId` - Location ID
- `ignoreDateRange` - Date range validation flag
- `ignoreFreeSlotValidation` - Slot validation flag
- `GHL_LOCATION_ID` - Location ID from environment
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `payload` - Request payload object

---

### 15. List Appointments for Contact

**Function:** `listAppointmentsForContact(contactId)`

**Endpoint:**
```
GET https://services.leadconnectorhq.com/contacts/{contactId}/appointments
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-04-15`

**Parameters:**
- `contactId` (string, required) - Contact ID

**Returns:**
- Array of appointment objects (`events` array from response)

**Code Location:** Lines 126-149

**Variables Used:**
- `contactId` - Contact identifier
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `events` - Appointments array from response

---

### 16. Update Appointment Status

**Function:** `updateAppointmentStatus(appointmentId, status, calendarId = null)`

**Endpoint:**
```
PUT https://services.leadconnectorhq.com/calendars/events/appointments/{appointmentId}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-04-15`

**Parameters:**
- `appointmentId` (string, required) - Appointment ID
- `status` (string, required) - New status: "new", "confirmed", "cancelled", etc.
- `calendarId` (string, optional) - Calendar ID (required by some GHL clusters)

**Payload Structure:**
```javascript
{
  appointmentStatus: string,
  toNotify: false,
  calendarId: string // Optional
}
```

**Returns:**
- Updated appointment object

**Code Location:** Lines 157-195

**Variables Used:**
- `appointmentId` - Appointment identifier
- `status` - New status string
- `calendarId` - Calendar identifier (optional)
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `payload` - Request payload object

---

### 17. Reschedule Appointment

**Function:** `rescheduleAppointment(appointmentId, { startTime, endTime, appointmentStatus, calendarId, assignedUserId })`

**Endpoint:**
```
PUT https://services.leadconnectorhq.com/calendars/events/appointments/{appointmentId}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-04-15`

**Parameters:**
- `appointmentId` (string, required) - Appointment ID
- `startTime` (string, required) - New start datetime (ISO)
- `endTime` (string, required) - New end datetime (ISO)
- `appointmentStatus` (string, optional) - Status to set
- `calendarId` (string, optional) - Calendar ID (required by some clusters)
- `assignedUserId` (string, optional) - Assigned user ID (required for translator calendars)

**Payload Structure:**
```javascript
{
  startTime: string,
  endTime: string,
  ignoreFreeSlotValidation: true,
  overrideLocationConfig: true,
  toNotify: false,
  calendarId: string, // Optional
  assignedUserId: string, // Optional
  appointmentStatus: string // Optional
}
```

**Returns:**
- Updated appointment object

**Code Location:** Lines 201-251

**Variables Used:**
- `appointmentId` - Appointment identifier
- `startTime` - New start datetime
- `endTime` - New end datetime
- `appointmentStatus` - Status string (optional)
- `calendarId` - Calendar identifier (optional)
- `assignedUserId` - Assigned user ID (optional)
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `payload` - Request payload object

---

### 18. Get Consult Appointments for Contact

**Function:** `getConsultAppointmentsForContact(contactId, consultCalendarIds)`

**Description:** Filters appointments for a contact to only include future appointments on consult calendars.

**Endpoint:** Uses `listAppointmentsForContact()`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `consultCalendarIds` (array, required) - Array of calendar IDs to filter by

**Returns:**
- Filtered array of appointment objects (future, non-cancelled, on consult calendars)

**Code Location:** Lines 259-282

**Variables Used:**
- `contactId` - Contact identifier
- `consultCalendarIds` - Array of calendar IDs
- `allAppointments` - All appointments from API
- `now` - Current date/time

---

### 19. Get Calendar Free Slots

**Function:** `getCalendarFreeSlots(calendarId, startDate, endDate)`

**Endpoint:**
```
GET https://services.leadconnectorhq.com/calendars/{calendarId}/free-slots?startDate={startMs}&endDate={endMs}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-04-15`

**Parameters:**
- `calendarId` (string, required) - Calendar ID to query
- `startDate` (Date, required) - Start of date range
- `endDate` (Date, required) - End of date range (max 31 days from startDate)

**Query Parameters:**
- `startDate` - Milliseconds timestamp
- `endDate` - Milliseconds timestamp (capped at 31 days from start)

**Returns:**
- Array of slot objects with:
  - `startTime` (ISO string)
  - `endTime` (ISO string)
  - `calendarId` (string)

**Code Location:** Lines 293-352

**Variables Used:**
- `calendarId` - Calendar identifier
- `startDate` - Start date object
- `endDate` - End date object
- `startMs` - Start timestamp in milliseconds
- `endMs` - End timestamp in milliseconds
- `maxRangeMs` - Maximum range (31 days in ms)
- `finalEndMs` - Final end timestamp (capped)
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `slots` - Parsed slots array
- `dateKey` - Date key from response
- `dateData` - Date data from response
- `slotTime` - Individual slot time string

**Note:** GHL API constraint - date range cannot exceed 31 days. Function automatically caps the range.

---

## Opportunities & CRM Pipeline

**Base URL:** `https://services.leadconnectorhq.com`  
**Client File:** `src/clients/ghlOpportunityClient.js`

### 20. Create Opportunity

**Function:** `createOpportunity({ contactId, name, pipelineId, pipelineStageId, status, monetaryValue, source, assignedUserId })`

**Endpoint:**
```
POST https://services.leadconnectorhq.com/opportunities/
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-07-28`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `name` (string, optional) - Opportunity name (default: "Tattoo Opportunity")
- `pipelineId` (string, optional) - Pipeline ID (default: `PIPELINE_ID` from config)
- `pipelineStageId` (string, required) - Pipeline stage ID
- `status` (string, optional) - Status: "open" (default)
- `monetaryValue` (number, optional) - Monetary value (default: 0)
- `source` (string, optional) - Source (default: "AI Setter")
- `assignedUserId` (string, optional) - Assigned user ID

**Payload Structure:**
```javascript
{
  locationId: string,
  pipelineId: string,
  pipelineStageId: string,
  contactId: string,
  name: string,
  status: string,
  monetaryValue: number,
  source: string,
  assignedUserId: string // Optional
}
```

**Returns:**
- Created opportunity object

**Code Location:** Lines 25-62

**Variables Used:**
- `contactId` - Contact identifier
- `name` - Opportunity name
- `pipelineId` - Pipeline identifier
- `pipelineStageId` - Pipeline stage identifier
- `status` - Status string
- `monetaryValue` - Monetary value number
- `source` - Source string
- `assignedUserId` - Assigned user ID
- `GHL_LOCATION_ID` - Location ID from environment
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `PIPELINE_ID` - Pipeline ID from config
- `payload` - Request payload object

---

### 21. Upsert Opportunity

**Function:** `upsertOpportunity({ contactId, name, pipelineId, pipelineStageId, status, monetaryValue, source, assignedTo, assignedUserId })`

**Endpoint:**
```
POST https://services.leadconnectorhq.com/opportunities/upsert
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-07-28`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `name` (string, optional) - Opportunity name (default: "Tattoo Opportunity")
- `pipelineId` (string, optional) - Pipeline ID (default: `PIPELINE_ID`)
- `pipelineStageId` (string, required) - Pipeline stage ID
- `status` (string, optional) - Status: "open" (default)
- `monetaryValue` (number, optional) - Monetary value (default: 0)
- `source` (string, optional) - Source (default: "AI Setter")
- `assignedTo` (string, optional) - Assigned user ID (GHL API expects this)
- `assignedUserId` (string, optional) - Assigned user ID (backwards compatibility)

**Payload Structure:**
```javascript
{
  locationId: string,
  pipelineId: string,
  pipelineStageId: string,
  contactId: string,
  name: string,
  status: string,
  monetaryValue: number,
  source: string,
  assignedTo: string // Optional (preferred over assignedUserId)
}
```

**Returns:**
- Upserted opportunity object

**Code Location:** Lines 64-105

**Variables Used:**
- `contactId` - Contact identifier
- `name` - Opportunity name
- `pipelineId` - Pipeline identifier
- `pipelineStageId` - Pipeline stage identifier
- `status` - Status string
- `monetaryValue` - Monetary value number
- `source` - Source string
- `assignedTo` - Assigned user ID (preferred)
- `assignedUserId` - Assigned user ID (backwards compat)
- `finalAssignee` - Resolved assignee value
- `GHL_LOCATION_ID` - Location ID
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `PIPELINE_ID` - Pipeline ID from config
- `payload` - Request payload object

---

### 22. Update Opportunity

**Function:** `updateOpportunity(opportunityId, body = {})`

**Endpoint:**
```
PUT https://services.leadconnectorhq.com/opportunities/{opportunityId}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-07-28`

**Parameters:**
- `opportunityId` (string, required) - Opportunity ID
- `body` (object, optional) - Fields to update (merged with `locationId`)

**Payload Structure:**
```javascript
{
  ...body,
  locationId: string
}
```

**Returns:**
- Updated opportunity object

**Code Location:** Lines 107-121

**Variables Used:**
- `opportunityId` - Opportunity identifier
- `body` - Update payload object
- `GHL_LOCATION_ID` - Location ID

---

### 23. Update Opportunity Stage

**Function:** `updateOpportunityStage({ opportunityId, pipelineStageId, status })`

**Description:** Updates the pipeline stage (and optionally status) of an opportunity.

**Endpoint:** Uses `updateOpportunity()`

**Parameters:**
- `opportunityId` (string, required) - Opportunity ID
- `pipelineStageId` (string, required) - New pipeline stage ID
- `status` (string, optional) - Status to set

**Returns:**
- Updated opportunity object

**Code Location:** Lines 123-128

**Variables Used:**
- `opportunityId` - Opportunity identifier
- `pipelineStageId` - Pipeline stage identifier
- `status` - Status string (optional)
- `PIPELINE_ID` - Pipeline ID from config
- `body` - Update payload object

---

### 24. Update Opportunity Value

**Function:** `updateOpportunityValue({ opportunityId, monetaryValue })`

**Description:** Updates the monetary value of an opportunity.

**Endpoint:** Uses `updateOpportunity()`

**Parameters:**
- `opportunityId` (string, required) - Opportunity ID
- `monetaryValue` (number, required) - New monetary value

**Returns:**
- Updated opportunity object

**Code Location:** Lines 130-132

**Variables Used:**
- `opportunityId` - Opportunity identifier
- `monetaryValue` - Monetary value number

---

### 25. Close Opportunity

**Function:** `closeOpportunity({ opportunityId, status = "won", monetaryValue })`

**Description:** Closes an opportunity with a status (won/lost) and optional monetary value.

**Endpoint:** Uses `updateOpportunity()`

**Parameters:**
- `opportunityId` (string, required) - Opportunity ID
- `status` (string, optional) - Status: "won" (default) or "lost"
- `monetaryValue` (number, optional) - Final monetary value

**Returns:**
- Updated opportunity object

**Code Location:** Lines 134-138

**Variables Used:**
- `opportunityId` - Opportunity identifier
- `status` - Status string
- `monetaryValue` - Monetary value number (optional)
- `body` - Update payload object

---

### 26. Add Opportunity Note

**Function:** `addOpportunityNote({ opportunityId, content })`

**Endpoint:**
```
POST https://services.leadconnectorhq.com/opportunities/{opportunityId}/notes
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-07-28`

**Parameters:**
- `opportunityId` (string, required) - Opportunity ID
- `content` (string, required) - Note content

**Payload Structure:**
```javascript
{
  locationId: string,
  content: string
}
```

**Returns:**
- Created note object or null

**Code Location:** Lines 140-155

**Variables Used:**
- `opportunityId` - Opportunity identifier
- `content` - Note content string
- `GHL_LOCATION_ID` - Location ID
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `payload` - Request payload object

---

### 27. Search Opportunities

**Function:** `searchOpportunities({ query = {}, pagination = null })`

**Endpoint:**
```
GET https://services.leadconnectorhq.com/opportunities/search?location_id={locationId}&contact_id={contactId}&assigned_to={assignedTo}&status={status}&startAfter={startAfter}&startAfterId={startAfterId}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-07-28`

**Query Parameters:**
- `location_id` (string, required) - Location ID
- `contact_id` (string, optional) - Filter by contact ID
- `assigned_to` (string, optional) - Filter by assigned user ID
- `status` (string, optional) - Filter by status: "open", "won", "lost", "abandoned", "all"
- `startAfter` (string, optional) - Pagination cursor
- `startAfterId` (string, optional) - Pagination ID

**Parameters:**
- `query` (object, optional) - Query filters:
  - `contactId` or `contact_id` (string)
  - `assignedTo` or `assigned_to` (string)
  - `status` (string)
  - `pipelineStageId` or `pipeline_stage_id` (string) - Client-side filtering only
  - `locationId` or `location_id` (string)
- `pagination` (object, optional) - Pagination:
  - `startAfter` (string)
  - `startAfterId` (string)

**Returns:**
- Array of opportunity objects (all pages fetched automatically)

**Code Location:** Lines 157-229

**Variables Used:**
- `query` - Query object
- `pagination` - Pagination object
- `contactId` - Contact identifier
- `assignedTo` - Assigned user identifier
- `status` - Status filter
- `pipelineStageId` - Pipeline stage filter (client-side)
- `locationId` - Location identifier
- `GHL_LOCATION_ID` - Location ID from environment
- `params` - URLSearchParams object
- `url` - Request URL
- `results` - Results array
- `opportunities` - Opportunities from response
- `nextPageUrl` - Next page URL from response
- `filtered` - Filtered results array

**Note:** 
- Requires at least `contact_id` OR `assigned_to` filter
- Automatically fetches all pages
- `pipelineStageId` filtering is done client-side (not supported by API)

---

### 28. Get Opportunity

**Function:** `getOpportunity(opportunityId)`

**Endpoint:**
```
GET https://services.leadconnectorhq.com/opportunities/{opportunityId}?locationId={locationId}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Accept: application/json`
- `Content-Type: application/json`
- `Version: 2021-07-28`

**Parameters:**
- `opportunityId` (string, required) - Opportunity ID

**Query Parameters:**
- `locationId` - Location ID (from `GHL_LOCATION_ID`)

**Returns:**
- Opportunity object

**Code Location:** Lines 231-236

**Variables Used:**
- `opportunityId` - Opportunity identifier
- `GHL_LOCATION_ID` - Location ID

---

### 29. Get Opportunities by Contact

**Function:** `getOpportunitiesByContact({ contactId, pipelineId = PIPELINE_ID })`

**Description:** Convenience wrapper for searching opportunities by contact ID.

**Endpoint:** Uses `searchOpportunities()`

**Parameters:**
- `contactId` (string, required) - Contact ID
- `pipelineId` (string, optional) - Pipeline ID (kept for signature compatibility, not used)

**Returns:**
- Array of opportunity objects for the contact

**Code Location:** Lines 238-245

**Variables Used:**
- `contactId` - Contact identifier
- `pipelineId` - Pipeline identifier (unused, kept for compatibility)

---

## File Uploads

**Base URL:** `https://services.leadconnectorhq.com`  
**Client File:** `src/clients/ghlClient.js`

### 30. Upload Files to Tattoo Custom Field

**Function:** `uploadFilesToTattooCustomField(contactId, files = [])`

**Endpoint:**
```
POST https://services.leadconnectorhq.com/forms/upload-custom-files?contactId={contactId}&locationId={locationId}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}` or `${GHL_API_KEY}`
- `Accept: application/json`
- `Version: 2021-07-28`
- FormData headers (via `form.getHeaders()`)

**Parameters:**
- `contactId` (string, required) - Contact ID
- `files` (array, optional) - Array of file objects with:
  - `buffer` (Buffer) - File buffer
  - `originalname` (string) - Original filename
  - `mimetype` (string) - MIME type

**Query Parameters:**
- `contactId` - Contact ID
- `locationId` - Location ID (from `GHL_LOCATION_ID`)

**Form Data:**
- Keys: `${customFieldId}_1`, `${customFieldId}_2`, etc.
- Values: File buffers with filename and contentType

**Returns:**
- API response data

**Code Location:** Lines 136-186

**Variables Used:**
- `contactId` - Contact identifier
- `files` - Files array
- `locationId` - Location ID from environment
- `customFieldId` - Custom field ID from environment (`GHL_TATTOO_FILE_FIELD_ID`)
- `form` - FormData instance
- `key` - Form field key (`${customFieldId}_${idx + 1}`)
- `token` - API token (`GHL_FILE_UPLOAD_TOKEN` or `GHL_API_KEY`)

**Environment Variables:**
- `GHL_LOCATION_ID` - Location ID
- `GHL_TATTOO_FILE_FIELD_ID` - Custom field ID for tattoo files
- `GHL_FILE_UPLOAD_TOKEN` - API token (falls back to `GHL_API_KEY`)

---

## Contact Assignment & Followers (v2 API)

**Base URL:** `https://services.leadconnectorhq.com`  
**Client File:** `src/clients/ghlClient.js`

### 31. Assign Contact to Artist

**Function:** `assignContactToArtist(contactId, assignedToId = MESSAGE_CONSULT_ARTIST_ID)`

**Description:** Assigns an artist to a contact using GHL v2 API. Used when lead chooses message-based consultation and deposit is paid.

**Endpoint:**
```
PUT https://services.leadconnectorhq.com/contacts/{contactId}
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Content-Type: application/json`
- `Accept: application/json`
- `Version: 2021-07-28` (Required for GHL v2 API)

**Parameters:**
- `contactId` (string, required) - Contact ID to assign
- `assignedToId` (string, optional) - User ID to assign (default: `MESSAGE_CONSULT_ARTIST_ID`)

**Payload Structure:**
```javascript
{
  assignedTo: string
}
```

**Returns:**
- API response data or null

**Code Location:** Lines 1071-1112

**Variables Used:**
- `contactId` - Contact identifier
- `assignedToId` - Assigned user ID
- `MESSAGE_CONSULT_ARTIST_ID` - Default artist ID constant (`"y0BeYjuRIlDwsDcOHOJo"`)
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `payload` - Request payload object

**Constants:**
- `MESSAGE_CONSULT_ARTIST_ID` = `"y0BeYjuRIlDwsDcOHOJo"` - Artist ID for message-based consultations

---

### 32. Add Followers to Contact

**Function:** `addFollowersToContact(contactId, followerIds)`

**Description:** Adds followers to a contact using GHL v2 API. Used to add translator as follower for video call consultations.

**Endpoint:**
```
POST https://services.leadconnectorhq.com/contacts/{contactId}/followers
```

**Headers:**
- `Authorization: Bearer ${GHL_FILE_UPLOAD_TOKEN}`
- `Content-Type: application/json`
- `Accept: application/json`
- `Version: 2021-07-28` (Required for GHL v2 API)

**Parameters:**
- `contactId` (string, required) - Contact ID
- `followerIds` (string|string[], required) - Single follower ID or array of follower IDs

**Payload Structure:**
```javascript
{
  followers: string[]
}
```

**Returns:**
- API response data or null

**Code Location:** Lines 1122-1166

**Variables Used:**
- `contactId` - Contact identifier
- `followerIds` - Follower ID(s)
- `followers` - Normalized followers array
- `GHL_FILE_UPLOAD_TOKEN` - API token
- `payload` - Request payload object

---

### 33. Add Translator as Follower

**Function:** `addTranslatorAsFollower(contactId)`

**Description:** Convenience wrapper for adding the default translator follower.

**Endpoint:** Uses `addFollowersToContact()`

**Parameters:**
- `contactId` (string, required) - Contact ID

**Returns:**
- API response data or null

**Code Location:** Lines 1175-1178

**Variables Used:**
- `contactId` - Contact identifier
- `TRANSLATOR_FOLLOWER_ID` - Translator ID constant (`"sx6wyHhbFdRXh302Lunr"`)

**Constants:**
- `TRANSLATOR_FOLLOWER_ID` = `"sx6wyHhbFdRXh302Lunr"` - Translator user ID

---

## User IDs and Calendar IDs Explained

Understanding how User IDs and Calendar IDs work is crucial for successful GHL API calls. This section explains their purpose and how they're used in API requests.

### User IDs (assignedUserId / assignedTo)

**What are User IDs?**
User IDs are unique identifiers for team members/users in your GHL account. They're used to assign contacts, appointments, opportunities, and tasks to specific team members.

**Where User IDs are Defined:**
- `ARTIST_ASSIGNED_USER_IDS` - Maps artist names to their GHL user IDs (in `src/config/constants.js`)
- `TRANSLATOR_USER_IDS` - Maps translator names to their GHL user IDs (in `src/config/constants.js`)
- `MESSAGE_CONSULT_ARTIST_ID` - Default artist for message consultations (in `src/clients/ghlClient.js`)
- `TRANSLATOR_FOLLOWER_ID` - Default translator follower ID (in `src/clients/ghlClient.js`)

**How User IDs are Used in API Calls:**

#### 1. Contact Assignment (`assignedTo` / `assignedUserId`)

**Endpoint:** `PUT /contacts/{contactId}` (v2 API)

**Function:** `assignContactToArtist(contactId, assignedToId)`

**Payload:**
```javascript
{
  "assignedTo": "y0BeYjuRIlDwsDcOHOJo" // User ID of the artist
}
```

**Purpose:** Assigns a contact to a specific team member (artist). This determines who "owns" the contact in the CRM.

**Used When:**
- Lead chooses message-based consultation and deposit is paid
- Contact needs to be assigned to a specific artist

**Code Example:**
```javascript
await assignContactToArtist(contactId, MESSAGE_CONSULT_ARTIST_ID);
// Uses: PUT /contacts/{contactId} with { assignedTo: "y0BeYjuRIlDwsDcOHOJo" }
```

---

#### 2. Appointment Assignment (`assignedUserId`)

**Endpoint:** `POST /calendars/events/appointments`

**Function:** `createAppointment({ assignedUserId, ... })`

**Payload:**
```javascript
{
  "calendarId": "2EJcAtrllnYOtuSx4Dua",
  "contactId": "contact123",
  "assignedUserId": "Wl24x1ZrucHuHatM0ODD", // Artist's user ID
  "startTime": "2025-01-15T10:00:00Z",
  "endTime": "2025-01-15T10:30:00Z"
}
```

**Purpose:** Assigns the appointment to a specific team member. This user will receive notifications and the appointment appears on their calendar.

**Important Requirements:**
- The `assignedUserId` **must be a member of the calendar's team**, otherwise GHL will reject it with an error
- If assignment fails, the code automatically retries without `assignedUserId` to ensure the appointment is still created
- For translator appointments, the user ID must match the translator assigned to that calendar

**Code Example:**
```javascript
await createAppointment({
  calendarId: CALENDARS.JOAN_ONLINE,
  contactId: contactId,
  assignedUserId: ARTIST_ASSIGNED_USER_IDS.JOAN, // "Wl24x1ZrucHuHatM0ODD"
  startTime: startTime,
  endTime: endTime
});
```

**Error Handling:**
If GHL rejects the `assignedUserId` (user not part of calendar team), the code:
1. Catches the error
2. Detects "user id not part of calendar team" error
3. Retries appointment creation without `assignedUserId`
4. Logs a warning

---

#### 3. Opportunity Assignment (`assignedTo` / `assignedUserId`)

**Endpoint:** `POST /opportunities/` or `POST /opportunities/upsert`

**Functions:** `createOpportunity()`, `upsertOpportunity()`

**Payload:**
```javascript
{
  "contactId": "contact123",
  "assignedTo": "Wl24x1ZrucHuHatM0ODD" // User ID (v2 API expects "assignedTo")
}
```

**Purpose:** Assigns the opportunity/deal to a specific team member for tracking and follow-up.

**Note:** v2 API expects `assignedTo` field name, but the code accepts `assignedUserId` for backwards compatibility and maps it to `assignedTo`.

**Code Example:**
```javascript
await upsertOpportunity({
  contactId: contactId,
  assignedTo: ARTIST_ASSIGNED_USER_IDS.JOAN // Maps to "assignedTo" in payload
});
```

---

#### 4. Task Assignment (`assignedTo`)

**Endpoint:** `POST /contacts/{contactId}/tasks` (v2 API)

**Function:** `createTaskForContact(contactId, { assignedTo, ... })`

**Payload:**
```javascript
{
  "title": "Follow up",
  "body": "Task description",
  "completed": false,
  "assignedTo": "Wl24x1ZrucHuHatM0ODD" // User ID (optional)
}
```

**Purpose:** Assigns a task to a specific team member for follow-up actions.

**Code Example:**
```javascript
await createTaskForContact(contactId, {
  title: "Consultation follow-up",
  assignedTo: ARTIST_ASSIGNED_USER_IDS.JOAN // Optional
});
```

---

#### 5. Contact Followers (`followers`)

**Endpoint:** `POST /contacts/{contactId}/followers` (v2 API)

**Functions:** `addFollowersToContact()`, `addTranslatorAsFollower()`

**Payload:**
```javascript
{
  "followers": ["sx6wyHhbFdRXh302Lunr"] // Array of user IDs
}
```

**Purpose:** Adds users as followers to a contact. Followers receive notifications about contact activity.

**Used When:**
- Adding translator as follower for video call consultations
- Multiple team members need to track a contact

**Code Example:**
```javascript
await addTranslatorAsFollower(contactId);
// Uses: POST /contacts/{contactId}/followers with { followers: ["sx6wyHhbFdRXh302Lunr"] }
```

---

### Calendar IDs (calendarId)

**What are Calendar IDs?**
Calendar IDs are unique identifiers for calendars in your GHL account. Each calendar represents a booking calendar for a specific artist, service type, or purpose.

**Where Calendar IDs are Defined:**
- `CALENDARS` - Maps artist names and consultation types to calendar IDs (in `src/config/constants.js`)
- `TRANSLATOR_CALENDARS` - Maps translator names to their calendar IDs (in `src/config/constants.js`)

**How Calendar IDs are Used in API Calls:**

#### 1. Creating Appointments (`calendarId` - **REQUIRED**)

**Endpoint:** `POST /calendars/events/appointments`

**Function:** `createAppointment({ calendarId, ... })`

**Payload:**
```javascript
{
  "calendarId": "2EJcAtrllnYOtuSx4Dua", // REQUIRED - Which calendar to book on
  "contactId": "contact123",
  "startTime": "2025-01-15T10:00:00Z",
  "endTime": "2025-01-15T10:30:00Z"
}
```

**Purpose:** Determines which calendar the appointment is created on. The calendar ID is **required** - without it, GHL doesn't know which calendar to book on.

**What Calendar ID Determines:**
- Which artist's calendar the appointment appears on
- What availability/slots are available
- What team members can be assigned (must be members of that calendar's team)
- Calendar-specific settings (timezone, availability rules, etc.)

**Code Example:**
```javascript
await createAppointment({
  calendarId: CALENDARS.JOAN_ONLINE, // "2EJcAtrllnYOtuSx4Dua"
  contactId: contactId,
  startTime: startTime,
  endTime: endTime
});
```

---

#### 2. Getting Free Slots (`calendarId` - **REQUIRED**)

**Endpoint:** `GET /calendars/{calendarId}/free-slots?startDate={startMs}&endDate={endMs}`

**Function:** `getCalendarFreeSlots(calendarId, startDate, endDate)`

**Purpose:** Queries availability for a specific calendar. Returns available time slots based on that calendar's schedule and existing appointments.

**Code Example:**
```javascript
const slots = await getCalendarFreeSlots(
  CALENDARS.JOAN_ONLINE, // "2EJcAtrllnYOtuSx4Dua"
  startDate,
  endDate
);
// Returns array of available slots for Joan's online calendar
```

**Important:** Each calendar has its own availability, so you must query the specific calendar you want to book on.

---

#### 3. Updating Appointment Status (`calendarId` - Optional but Recommended)

**Endpoint:** `PUT /calendars/events/appointments/{appointmentId}`

**Function:** `updateAppointmentStatus(appointmentId, status, calendarId)`

**Payload:**
```javascript
{
  "appointmentStatus": "confirmed",
  "calendarId": "2EJcAtrllnYOtuSx4Dua" // Optional but recommended
}
```

**Purpose:** Some GHL clusters require `calendarId` for proper appointment updates. Including it ensures the update is applied correctly.

**Code Example:**
```javascript
await updateAppointmentStatus(appointmentId, "confirmed", CALENDARS.JOAN_ONLINE);
```

---

#### 4. Rescheduling Appointments (`calendarId` - Optional)

**Endpoint:** `PUT /calendars/events/appointments/{appointmentId}`

**Function:** `rescheduleAppointment(appointmentId, { calendarId, ... })`

**Payload:**
```javascript
{
  "startTime": "2025-01-16T10:00:00Z",
  "endTime": "2025-01-16T10:30:00Z",
  "calendarId": "2EJcAtrllnYOtuSx4Dua" // Optional - required by some clusters
}
```

**Purpose:** Required by some GHL clusters for proper rescheduling. Also used when moving appointments between calendars.

**Code Example:**
```javascript
await rescheduleAppointment(appointmentId, {
  startTime: newStartTime,
  endTime: newEndTime,
  calendarId: CALENDARS.JOAN_ONLINE // Required by some clusters
});
```

---

#### 5. Filtering Appointments (`consultCalendarIds`)

**Function:** `getConsultAppointmentsForContact(contactId, consultCalendarIds)`

**Purpose:** Filters appointments to only those on specific calendars. Used to identify consultation appointments vs other types.

**Code Example:**
```javascript
const consultAppointments = await getConsultAppointmentsForContact(contactId, [
  CALENDARS.JOAN_ONLINE,      // "2EJcAtrllnYOtuSx4Dua"
  CALENDARS.ANDREW_ONLINE,    // "2EJcAtrllnYOtuSx4Dua"
  TRANSLATOR_CALENDARS.LIONEL_ONLINE // "mmLWt370a94tbaNQIgNw"
]);
// Returns only appointments on these consult calendars
```

---

### How User IDs and Calendar IDs Work Together

**Example: Creating an Appointment with Assignment**

```javascript
// 1. Determine which calendar to use based on artist and consultation type
const calendarId = CALENDARS.JOAN_ONLINE; // "2EJcAtrllnYOtuSx4Dua"

// 2. Get the artist's user ID for assignment
const assignedUserId = ARTIST_ASSIGNED_USER_IDS.JOAN; // "Wl24x1ZrucHuHatM0ODD"

// 3. Create appointment with both calendar and user ID
await createAppointment({
  calendarId: calendarId,           // Which calendar to book on (REQUIRED)
  contactId: contactId,
  assignedUserId: assignedUserId,    // Which user to assign to (optional)
  startTime: startTime,
  endTime: endTime
});

// 4. If translator is needed, create separate appointment on translator calendar
const translatorCalendarId = TRANSLATOR_CALENDARS.LIONEL_ONLINE; // "mmLWt370a94tbaNQIgNw"
const translatorUserId = TRANSLATOR_USER_IDS.LIONEL; // "1kFG5FWdUDhXLUX46snG"

await createAppointment({
  calendarId: translatorCalendarId,
  contactId: contactId,
  assignedUserId: translatorUserId,  // Translator's user ID
  startTime: startTime,
  endTime: endTime
});
```

**Key Relationships:**
- **Calendar ID determines availability** - Each calendar has its own schedule and slots
- **User ID must match calendar team** - The `assignedUserId` must be a member of the calendar's team
- **Multiple calendars per artist** - Artists can have separate calendars for in-person vs online
- **Translator calendars are separate** - Linked to artist appointments via pairing keys in descriptions

**Error Handling:**
If the `assignedUserId` is not part of the calendar's team, GHL will return an error like:
```
"user id not part of calendar team"
```

The code handles this by:
1. Catching the error
2. Detecting if it's a calendar team membership error
3. Retrying appointment creation without `assignedUserId`
4. Logging a warning

This ensures appointments are still created even if assignment fails.

---

## Environment Variables

All GHL API calls use the following environment variables:

- `GHL_API_KEY` - Primary API authentication token (v1 API)
- `GHL_FILE_UPLOAD_TOKEN` - API token for v2 API and file uploads (falls back to `GHL_API_KEY`)
- `GHL_LOCATION_ID` - Location ID for all API calls
- `GHL_TATTOO_FILE_FIELD_ID` - Custom field ID for tattoo file uploads

---

## API Versions

- **v1 API** (`https://rest.gohighlevel.com`): Used for contact management (GET, POST, PUT, lookup)
- **v2 API** (`https://services.leadconnectorhq.com`): Used for conversations, calendar, opportunities, file uploads, contact assignment, and **task creation**

**Version Headers:**
- `Version: 2021-04-15` - Used for calendar and conversation search endpoints
- `Version: 2021-07-28` - Used for conversations messages, opportunities, file uploads, v2 contact endpoints, and **task creation**

---

## V1 API Test Results

**Test Date:** January 2025  
**Test Script:** `test_ghl_v1_api.js`

### Tested Endpoints:

1. ✅ **POST /v1/contacts/** - Create contact — **WORKING**
2. ✅ **GET /v1/contacts/{contactId}** - Get contact — **WORKING**
3. ✅ **GET /v1/contacts/lookup?email={email}** - Lookup contact — **WORKING**
4. ✅ **PUT /v1/contacts/{contactId}** - Update contact — **WORKING**
5. ❌ **POST /v1/contacts/{contactId}/tasks** - Create task — **FAILING** (migrated to v2)

### V1 API Status Summary:

**4 out of 5 endpoints tested are functional.** The task creation endpoint was failing with validation errors and has been successfully migrated to the v2 API.

**Working v1 Endpoints:**
- Contact CRUD operations (create, read, update)
- Contact lookup by email/phone

**Migrated to v2:**
- Task creation (now uses `/contacts/:contactId/tasks` with v2 API format)

**Note:** The v1 API task endpoint (`/v1/contacts/{contactId}/tasks`) was returning 422 errors with status validation issues. The v2 API endpoint works correctly with `completed: boolean` instead of `status: string`.

---

## Custom Field Mappings

### Widget Custom Fields → GHL Field IDs

Defined in `CUSTOM_FIELD_MAP` (lines 24-39):

- `language_preference` → `"ETxasC6QlyxRaKU18kbz"`
- `inquired_technician` → `"H3PSN8tZSw1kYckHJN9D"`
- `whatsapp_user` → `"FnYDobmYqnXDxlLJY5oe"`
- `tattoo_title` → `"8JqgdVJraABsqgUeqJ3a"`
- `tattoo_summary` → `"xAGtMfmbxtfCHdo2oyf7"`
- `tattoo_placement` → `"jd8YhvKsBi4aGqjqOEOv"`
- `tattoo_style` → `"12b2O4ydlfO99FA4yCuk"`
- `tattoo_size` → `"KXtfZYdeSKUyS5llTKsr"`
- `tattoo_color_preference` → `"SzyropMDMcitUDhhb8dd"`
- `how_soon_is_client_deciding` → `"ra4Nk80WMA8EQkLCfXST"`
- `first_tattoo` → `"QqDydmY1fnldidlcMnBC"`
- `tattoo_concerns` → `"tattoo_concerns"` (TODO: Get actual ID)
- `tattoo_photo_description` → `"ptrJy8TBBjlnRWQepdnP"`

### System Fields

Defined in `SYSTEM_FIELD_MAP` (lines 47-52), mapped from `SYSTEM_FIELDS` in `src/config/constants.js`:
- `ai_phase`
- `lead_temperature`
- `deposit_link_sent`
- `deposit_paid`
- `last_phase_update_at`

---

## Summary

**Total API Endpoints:** 33

**By Category:**
- Contact Management: 9 endpoints (8 v1, 1 v2 for tasks)
- Conversations & Messaging: 4 endpoints (all v2)
- Calendar & Appointments: 6 endpoints (all v2)
- Opportunities & CRM Pipeline: 10 endpoints (all v2)
- File Uploads: 1 endpoint (v2)
- Contact Assignment & Followers: 3 endpoints (all v2)

**API Version Breakdown:**
- **v1 API:** 8 endpoints (contact CRUD operations) - ✅ All tested and working
- **v2 API:** 25 endpoints (all other operations + task creation) - ✅ Task creation tested and working

**API Bases:**
- `https://rest.gohighlevel.com` (v1 API) - Contact management (GET, POST, PUT, lookup)
- `https://services.leadconnectorhq.com` (v2 API) - All other operations + task creation

