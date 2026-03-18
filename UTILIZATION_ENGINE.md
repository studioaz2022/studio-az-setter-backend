# Chair Utilization Engine — Technical Reference

> For the IT professional reviewing and improving the capacity/utilization algorithm.

---

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [What We're Building and Why](#what-were-building-and-why)
3. [The Capacity Formula](#the-capacity-formula)
4. [Calendar Hierarchy](#calendar-hierarchy)
5. [Schedule Envelope](#schedule-envelope)
6. [Break Cost Calculation](#break-cost-calculation)
7. [Dead Space Deduction](#dead-space-deduction)
8. [H+B Bleed Expansion](#hb-bleed-expansion)
9. [Availability Metrics](#availability-metrics)
10. [Problems We've Been Solving](#problems-weve-been-solving)
11. [Open Questions](#open-questions)
12. [How to Run Tests](#how-to-run-tests)
13. [Key Files](#key-files)
14. [Access & Setup](#access--setup)
15. [GHL API Reference](#ghl-api-reference)

---

## The Big Picture

Studio AZ is a barbershop in Minneapolis with ~9 barbers. Each barber has their own set of GHL (GoHighLevel) booking calendars. We're building an analytics platform that tells each barber:

1. **How much money they're leaving on the floor** (the "Money Leak Scorecard")
2. **Where their growth funnel leaks** (attract → book → show up → satisfy → rebook → retain)
3. **AI-powered coaching** grounded in barbershop business principles

**Chair utilization** is one of the core metrics — it answers: "What percentage of your bookable time did you actually spend cutting hair?"

The full vision is documented in two plan files (included in the repo):
- `BARBER_ANALYTICS_PLAN.md` — The analytics roadmap (Tiers 1-3 + AI Coach)
- `MONEY_LEAK_SCORECARD_PHASES.md` — The scorecard feature (money on the floor, focus metrics, Monday ritual)

---

## What We're Building and Why

### The Scorecard Philosophy (from MONEY_LEAK_SCORECARD_PHASES.md)

The analytics tab isn't a stats dashboard. It's a **scoreboard** that:
1. Leads with emotion: "You left $X on the floor this month"
2. Shows ONE focus area with a dynamic, capacity-aware goal
3. Tells human stories per stat with transparent math
4. Tracks weekly income goal vs pace
5. Sends a Monday morning push notification to create a ritual

**Two hero metrics:** New client count + Non-regular rebook rate. Chair utilization is a supporting metric that feeds into the "money on the floor" calculation and Cap Zone pricing analysis.

### Where Utilization Fits

```
Money on the Floor = f(rebooking_rate, avg_revenue, utilization, ...)

Cap Zone Analysis:
  - Revenue per available hour (uses capacity from utilization engine)
  - Overflow demand detection (utilization > 100%)
  - Suggested price bump (when demand exceeds supply)

Availability Metrics (owner-facing):
  - Shop Impact = Utilization × Availability Index
  - "How much is this chair contributing to the shop's output?"
```

---

## The Capacity Formula

```
dayCapacity = rawScheduleMinutes
            - breakCostMinutes
            - deadSpaceMinutes
            + hbBleedMinutes

utilization = utilizedMinutes / dayCapacity × 100
```

| Component | What it is | Source |
|-----------|-----------|--------|
| **rawScheduleMinutes** | Total scheduled hours before any deductions | Union of HC + HC_FF calendar schedule rules |
| **breakCostMinutes** | Time consumed by breaks, slot-aligned to the booking grid | Calendar Events API (break-titled events from any calendar) + Blocked Slots API |
| **deadSpaceMinutes** | Unbookable gaps between appointments (< minimum slot duration) | Computed from event start/end times |
| **hbBleedMinutes** | Extra capacity from H+B appointments bleeding past schedule end or into breaks | Computed per H+B client event |
| **utilizedMinutes** | Actual minutes spent on client appointments | Calendar Events API (non-break, non-cancelled events from kiosk calendars) |

---

## Calendar Hierarchy

Each barber has multiple GHL calendars. Lionel's config (from `kioskConfig.js`):

```js
{
  name: 'Lionel Chavez',
  ghlUserId: '1kFG5FWdUDhXLUX46snG',
  calendars: {
    haircut:           'Bsv9ngkRgsbLzgtN3Vpq',  // HC — 30min dur, 30min interval
    haircut_beard:     'pGNsYjGyEYW9LCD1GcQN',  // H+B — 45min dur, 30min interval
    haircut_fnf:       '9a66xeZi2pEJWQpxiMjy',  // HC_FF — 30min dur, 30min interval
    haircut_beard_fnf: '0qOmPMcP7L4qz58fxmu4',  // HB_FF — 45min dur, 30min interval
  },
}
```

### Calendar Types and Their Roles

| Type | Duration | Interval | Role in Engine |
|------|----------|----------|----------------|
| `haircut` (HC) | 30 min | 30 min | **Envelope calendar** — defines capacity window |
| `haircut_fnf` (HC_FF) | 30 min | 30 min | **Envelope calendar** — defines capacity window |
| `haircut_beard` (H+B) | 45 min | 30 min | **Excluded from envelope** — 15 min padding would inflate capacity. Bleed expansion handles overflow. |
| `haircut_beard_fnf` (HB_FF) | 45 min | 30 min | Same as H+B |
| `beard_trim` (BT) | 20 min | 20 min | Excluded from everything — minor add-on, distorts grid |

### Why HC + HC_FF Define the Envelope (Not Work Hours)

Lionel has two haircut calendars: non-F&F opens earlier on some days, F&F closes later on others. The **actual window** where clients can be booked is the union of both:

| Day | HC (non-F&F) | HC_FF (F&F) | Union = Envelope | Work Hours (wrong) |
|-----|-------------|-------------|------------------|--------------------|
| Tue | 14:00-18:00 | 14:00-18:00 | 14:00-18:00 (240 min) | 14:00-18:00 |
| Wed | **10:30**-**17:00** | 11:00-16:30 | **10:30-17:00 (390 min)** | 11:00-16:30 (330) |
| Fri | 11:00-16:30 | 11:00-16:30 | 11:00-16:30 (330 min) | 11:00-16:30 |
| Sat | **10:00**-13:30 | 10:30-**14:30** | **10:00-14:30 (270 min)** | 10:30-14:30 (240) |

Work Hours doesn't reflect the actual booking window. The GHL "Work Hours" schedule (`calendarIds: []`) is a general availability marker, not the source of truth for when clients can book.

### Why H+B Is Excluded from the Envelope

H+B calendar schedule windows extend past HC windows to accommodate the 15-min service overflow:

```
Friday HC envelope:    11:00 ————————————————————————— 16:30
Friday H+B schedule:   11:00-11:45, 13:00-13:45, ... 15:00-16:45
                                                            ↑
                                            H+B goes 15 min past HC
```

If we included H+B in the envelope, capacity would expand by the full schedule window width — but only 15 min of that is actual service time. The H+B bleed expansion (below) handles this dynamically per appointment.

---

## Schedule Envelope

**Source:** GHL Schedules API (`GET /calendars/schedules/search`)

**Algorithm:**
1. Fetch all schedules for the barber
2. Find schedules linked to HC-type calendars (haircut, haircut_fnf, hot_towel_shave)
3. For each day, union all intervals → earliest start to latest end = envelope
4. Fallback to Work Hours schedule if no HC schedules found

```
scheduleRules = {
  tuesday:   [{ from: "14:00", to: "18:00" }],
  wednesday: [{ from: "10:30", to: "17:00" }],
  friday:    [{ from: "11:00", to: "16:30" }],
  saturday:  [{ from: "10:00", to: "14:30" }],
}
// Days not in this map = not working (no capacity)
```

---

## Break Cost Calculation

Breaks come from two sources:
1. **Calendar Events API** — events with "break", "lunch", "block", "time off", "blocked", or "unavailable" in the title. These can come from ANY calendar (Lionel puts breaks on a separate personal calendar, not the kiosk calendars).
2. **Blocked Slots API** — manually blocked time ranges. Injected as synthetic break events, clamped to the schedule window.

### Break Cost Formula

```
slotAlignedCost = ceil(breakDuration / slotInterval) × slotInterval
netCost = max(0, slotAlignedCost - reclaimedByPrev - reclaimedByNext)
```

**Slot alignment:** A 45-min break on a 30-min grid costs 60 min (2 slots), because the remaining 15 min can't fit another appointment.

**Reclaim:** If the appointment immediately before/after a break overflows past its own slot boundary, that overflow absorbs break padding. Example: a 45-min H+B ends at break start — its 15-min overflow means the break's padding is partially reclaimed.

### Break Merging

Overlapping or adjacent break events are merged before cost calculation. GHL sometimes splits a single break into multiple events (e.g., 1:00-2:45 + 2:45-3:00).

---

## Dead Space Deduction

Gaps between appointments that are too short to book another client.

```
if (gap > 0 && gap < minBookableDuration && !adjacentToBreak):
    deadSpaceMinutes += gap
```

- `minBookableDuration` = shortest primary calendar duration (usually 30 min for HC)
- Gaps adjacent to breaks are already covered by the break's slot-aligned cost
- Checked both between appointments and between last appointment and schedule end

---

## H+B Bleed Expansion

H+B appointments are 45 min on a 30-min slot. The 15-min overflow is real service time. When it bleeds past the schedule end or into a break, capacity should expand:

```
for each H+B client event:
    bleed = durationMin - slotInterval    // typically 15 min

    // Past schedule end
    if endMin > schedEnd:
        hbBleedMinutes += min(bleed, endMin - schedEnd)

    // Into break periods
    for each break:
        if appointment starts before break and ends after break starts:
            hbBleedMinutes += min(bleed, endMin - breakStart)
```

**Why this exists:** Without it, an H+B in the last slot (e.g., 16:00-16:45 on a 16:30 envelope) would show 15 min of utilized time with 0 capacity for it → inflated utilization. The bleed expansion attributes the 15 min correctly.

**>100% is still valid:** Barbers add clients before/after hours. A whole extra appointment past the schedule end (not just 15-min H+B bleed) will and should show as >100%. The bleed expansion only handles the H+B padding case.

---

## Availability Metrics

Three metrics for different audiences:

### 1. Availability Index (AI Coach context)
```
availabilityIndex = (rawSchedule - discretionaryBlocked) / rawSchedule × 100
```
- **Discretionary blocks** = `isRecurring: false` from Blocked Slots API (PTO, vacations)
- **Recurring blocks** = `isRecurring: true` (daily lunch) — reduce capacity but NOT counted against availability
- Purpose: "What % of your regular schedule are you actually available?"

### 2. Shop Impact (owner-facing)
```
shopImpact = utilization × availabilityIndex / 100
```
- When availability is 100%, shop impact = utilization
- When a barber blocks time off, shop impact drops proportionally
- Purpose: "What's this chair's real contribution to the shop?"

### 3. Blocked Percent + At Risk (barber-facing)
```
blockedPercent = discretionaryBlocked / rawSchedule × 100
atRisk = blockedPercent >= 25%
```
- **"At Risk" is shown as a subtle asterisk (*) next to utilization**, NOT a warning badge
- Design decision: barbers shouldn't feel penalized for taking time off
- The `*` links to a footnote: "Includes time you blocked off"

---

## Problems We've Been Solving

### Bug 1: Schedule Envelope Was Using Work Hours (FIXED)

**Problem:** The code preferred Work Hours schedule as the capacity source. But Work Hours showed Wed as 11:00-16:30 (330 min) when the actual booking window is 10:30-17:00 (390 min) because the non-F&F HC calendar opens at 10:30.

**Fix:** Union HC + HC_FF calendar schedules as the envelope. Work Hours is only a fallback.

**Commit:** `0c30f5e`

### Bug 2: Non-Working Days Showing Capacity (FIXED)

**Problem:** Thursday showed capacity despite Lionel not working Thursdays. Two causes:
1. The old union logic included Work Hours + calendar schedules, pulling in extra days
2. The `getStartDate(1, date)` function subtracted 1 day from the date, so a "1-day" snapshot actually spanned 2 days (including the previous working day)

**Fix:** (a) HC-only envelope excludes non-working days. (b) For `periodDays=1`, `startDate = asOfDate` (no subtraction).

**Commits:** `8e22414`, plus the `periodDays===1` fix in `getChairUtilization`

### Bug 3: Nightly Cron Computing "Today" at 2am (FIXED)

**Problem:** Cron runs at 2:00 AM Central. `computeBarberSnapshot()` with no `asOfDate` set `snapshotDate = new Date().toISOString().split("T")[0]` = today. But today hasn't happened yet at 2am — no appointments, no events. Historical mode returned empty/wrong data.

**Fix:** When `asOfDate` is null, compute yesterday (Central time). The startup `checkAndBackfill()` also checks yesterday.

**Commit:** `8e22414`

### Bug 4: Break Events From Non-Kiosk Calendars (FIXED — with nuance)

**Problem:** Calendar Events API returns events from ALL calendars. First fix filtered to kiosk calendars only — but that excluded legitimate breaks (Lionel puts breaks on a personal calendar). Second fix was too broad — included personal non-break appointments like "yur" (4-hour personal event that was classified as a client appointment).

**Final fix:** Include all kiosk-calendar events + break-titled events from ANY calendar. Non-break events from unknown calendars are excluded.

**Commits:** `743e934` (initial filter), `59cbb56` (refined to allow non-kiosk breaks)

### Bug 5: H+B Capacity Attribution (ADDED)

**Problem:** H+B appointments are 45 min on 30-min slots. When the 15-min overflow bleeds past the schedule end or into breaks, it should expand capacity — it's real service time, not "over-utilization."

**Fix:** Dynamic `hbBleedMinutes` expansion per H+B appointment that actually bleeds.

**Commit:** `215e32a`

**Note:** In current data (Mar 1-16), no H+B appointments actually trigger bleed expansion for Lionel — his H+B appointments happen mid-day within the envelope. The >100% utilization on Fri/Sat is from whole extra appointments past hours, which is correct behavior. The bleed logic is in place for when it does occur.

### Remaining Concerns

1. **Break cost might be aggressive on some days.** Wednesday shows 120 min break cost on a 390 min day — is a 2-hour break accurate? The breaks come from Lionel's personal calendar. Need to verify with Lionel whether those "Break" events on the personal calendar accurately reflect real break time vs. personal calendar artifacts.

2. **`_liveUtilization` (today/future) not yet updated** with the break-aware engine. It still uses the Free Slots API approach. Only `_historicalUtilization` has the full engine.

3. **Backfill needed.** All existing snapshot data was computed with the old buggy algorithm. Once the engine is validated, snapshots need to be re-backfilled:
   ```bash
   curl -X POST "https://studio-az-setter-backend.onrender.com/api/barbers/analytics/backfill-snapshots?startDate=2026-02-01&endDate=2026-03-17" \
     -H "Authorization: Bearer <admin-token>"
   ```

4. **Other barbers untested.** All debugging has been on Lionel. Each barber has different calendar configs (some have beard_trim, some don't have F&F calendars). The engine needs to be validated across all 9 barbers.

---

## How to Run Tests

### Quick Start

```bash
cd studio-az-setter-backend
cp .env.example .env   # Fill in the values (see Access section)
npm install
node scripts/test-utilization.js
```

### Test Commands

```bash
# Default: Lionel, last 7 days
node scripts/test-utilization.js

# Specific barber
node scripts/test-utilization.js --barber="Drew Smith"

# Specific date range
node scripts/test-utilization.js --start=2026-03-01 --end=2026-03-15

# Verbose: show every event, break, blocked slot per day
node scripts/test-utilization.js --verbose

# Raw: show GHL schedule rules and calendar configs
node scripts/test-utilization.js --raw

# Combine flags
node scripts/test-utilization.js --barber="Lionel Chavez" --start=2026-03-10 --end=2026-03-14 --verbose --raw
```

### Quick One-Liner Tests

```bash
# Single day for Lionel
node -e "
require('dotenv').config();
const { getChairUtilization } = require('./src/analytics/analyticsQueries');
(async () => {
  const r = await getChairUtilization('1kFG5FWdUDhXLUX46snG', 'GLRkNAxfPtWTqTiN83xj', 1, '2026-03-11');
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})();
"
```

### Available Barbers

| Name | GHL User ID | Calendar Types |
|------|------------|----------------|
| Lionel Chavez | `1kFG5FWdUDhXLUX46snG` | HC, H+B, HC_FF, HB_FF |
| Drew Smith | `zKiZ5w3ImX0bA7zrFIZx` | HC, H+B, BT |
| Logan Jensen | `XrbRTwVGMwgcGOgD2a5n` | HC, H+B, BT |
| Elle Gibeau | `sLkO5CwFrhdcM7EOtTvg` | HC, H+B |
| David Mackflin | `47m7vgAy8cwELwCBE3LT` | HC, H+B |
| Joshua Flores | `Dm20lBxWvG393LUoxuEV` | HC, H+B, BT |
| Albe Herrera | `m0i0Q9vfa2YTmxLrrriK` | HC, H+B, BT |
| Liam Meagher | `GBzpanPloybTcnPEIzpE` | HC, H+B, BT |
| Gilberto Castro | `F6m7GBKeyIRcehYkubfe` | HC, H+B |

---

## Key Files

| File | What it does | Lines of interest |
|------|-------------|-------------------|
| `src/analytics/analyticsQueries.js` | **THE ENGINE** — `_historicalUtilization()` is the core algorithm (~600 lines) | ~1123-1717 |
| `src/analytics/analyticsQueries.js` | `getChairUtilization()` — mode router (live/historical/hybrid) | ~740-795 |
| `src/analytics/analyticsQueries.js` | `_liveUtilization()` — today/future mode (not yet break-aware) | ~876-1120 |
| `src/analytics/snapshotCron.js` | Nightly cron + backfill — computes snapshots from the engine | Full file |
| `src/analytics/moneyLeakEngine.js` | Money Leak Scorecard — consumes utilization data | `computeFullScorecard()` |
| `src/config/kioskConfig.js` | Barber calendar mappings — **the source of truth** | Full file |
| `src/analytics/analyticsRoutes.js` | API endpoints including backfill | Backfill endpoint ~300-370 |
| `scripts/test-utilization.js` | Test runner (this doc's companion) | Full file |

---

## Access & Setup

### 1. GitHub Repository
```
https://github.com/studioaz2022/studio-az-setter-backend
```
Ask Lionel for collaborator access.

### 2. Environment Variables

Create `.env` in the repo root with:

```bash
# GHL — Barbershop location (PIT = Private Integration Token)
GHL_BARBER_LOCATION_ID=GLRkNAxfPtWTqTiN83xj
GHL_FILE_UPLOAD_TOKEN=<pit-token>          # Ask Lionel — this is the PIT token for the barbershop location

# Supabase
SUPABASE_URL=<url>                          # Ask Lionel
SUPABASE_SERVICE_ROLE_KEY=<key>             # Ask Lionel

# Not needed for utilization testing:
# SQUARE_*, OPENAI_*, INSTANT_*, etc.
```

The only env vars needed for utilization testing are the GHL and Supabase ones.

### 3. Supabase Access

Ask Lionel for an invite to the Supabase project dashboard. Key tables:

| Table | Purpose |
|-------|---------|
| `barber_analytics_snapshots` | Daily snapshot data (what the cron writes) |
| `appointments` | All appointment records (synced from GHL) |
| `transactions` | Payment records (from Square) |
| `barber_service_prices` | Service pricing per calendar |

### 4. GHL Access

Two options:
- **PIT token only** (simpler): Just the token in `.env` — sufficient for all API calls
- **GHL dashboard access**: Ask Lionel for a sub-account user on the Barbershop location in GoHighLevel. Lets you see calendars, contacts, and appointment data in the UI.

### 5. Direct GHL API Calls

```bash
# Fetch schedule rules for a barber
curl -s "https://services.leadconnectorhq.com/calendars/schedules/search?locationId=GLRkNAxfPtWTqTiN83xj&userId=1kFG5FWdUDhXLUX46snG" \
  -H "Authorization: Bearer <pit-token>" \
  -H "Version: 2021-07-28" | jq .

# Fetch calendar events for a specific day (epoch ms)
curl -s "https://services.leadconnectorhq.com/calendars/events?locationId=GLRkNAxfPtWTqTiN83xj&userId=1kFG5FWdUDhXLUX46snG&startTime=1741669200000&endTime=1741755599000" \
  -H "Authorization: Bearer <pit-token>" \
  -H "Version: 2021-04-15" | jq .
# NOTE: Version 2021-04-15 is REQUIRED for calendar events (SDK default returns empty)

# Fetch blocked slots
curl -s "https://services.leadconnectorhq.com/calendars/blocked-slots?locationId=GLRkNAxfPtWTqTiN83xj&userId=1kFG5FWdUDhXLUX46snG&startTime=1741669200000&endTime=1741755599000" \
  -H "Authorization: Bearer <pit-token>" \
  -H "Version: 2021-04-15" | jq .

# Get calendar config (slot duration, interval, openHours)
curl -s "https://services.leadconnectorhq.com/calendars/Bsv9ngkRgsbLzgtN3Vpq" \
  -H "Authorization: Bearer <pit-token>" \
  -H "Version: 2021-07-28" | jq .
```

---

## GHL API Reference

### Calendar Events API
```
GET /calendars/events?locationId={id}&userId={id}&startTime={epochMs}&endTime={epochMs}
Headers: { Version: '2021-04-15' }   ← CRITICAL — SDK default version returns empty
```
Returns all events (appointments + breaks) for the user in the time range. Events from ALL calendars, not just kiosk ones.

### Blocked Slots API
```
GET /calendars/blocked-slots?locationId={id}&userId={id}&startTime={epochMs}&endTime={epochMs}
Headers: { Version: '2021-04-15' }
```
Returns manually blocked time ranges. Key fields: `startTime`, `endTime`, `isRecurring`, `deleted`, `title`.

### Schedules API
```
GET /calendars/schedules/search?locationId={id}&userId={id}
```
Returns all schedules (Work Hours + per-calendar). Each schedule has `calendarIds` (empty = Work Hours) and `rules` with day/interval definitions.

### Calendar Config
```
GET /calendars/{calendarId}
```
Returns `slotDuration`, `slotDurationUnit`, `slotInterval`, `slotIntervalUnit`, `openHours`, `calendarType`.

---

## Current Test Results (Lionel, Mar 10-16)

```
Date       | Day | rawSch | Cap  | Used | Free | Deductions | Util    | Appts
-----------|-----|--------|------|------|------|------------|---------|------
2026-03-10 | Tue |    240 |  210 |  210 |    0 |         30 |  100.0% |     7
2026-03-11 | Wed |    390 |  270 |  270 |    0 |        120 |  100.0% |     9
2026-03-12 | Thu |      0 |    0 |    0 |    0 |          0 |    null |     0
2026-03-13 | Fri |    330 |  270 |  300 |    0 |         60 |  111.1% |    10
2026-03-14 | Sat |    270 |  240 |  300 |    0 |         30 |  125.0% |     8
2026-03-15 | Sun |      0 |    0 |    0 |    0 |          0 |    null |     0
2026-03-16 | Mon |      0 |    0 |    0 |    0 |          0 |    null |     0

Period: 109.1% utilization, 16.5h capacity, 18.0h utilized, 34 appointments
```

**What's correct:**
- Non-working days (Thu/Sun/Mon) = 0 capacity
- rawSchedule matches HC+HC_FF union exactly
- Breaks deducted from capacity (Wed 120 min, Tue/Sat 30 min)
- >100% on Fri/Sat = barber added clients past regular hours (expected, not a bug)

**What might need review:**
- Wed 120 min break cost — is a 2-hour break real or a calendar artifact?
- Fri 60 min deductions — break + dead space combined
- No H+B bleed triggered in this window (all H+B appointments fell within the envelope)
