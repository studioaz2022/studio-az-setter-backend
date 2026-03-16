# Backfill Scripts

> These scripts populate historical data from GHL and Square into Supabase.
> Run them during barber onboarding to ensure analytics are accurate from day one.

---

## 1. Appointment Backfill

**File:** `src/analytics/appointmentBackfill.js`

**Purpose:** Fetches all GHL appointments for a date range and inserts them into the `appointments` table. Existing rows (from webhooks) are preserved — only new rows are inserted.

**Endpoint:**
```
POST /api/barbers/analytics/backfill-appointments?start=2025-06-01&end=2026-03-16&barberGhlId=<GHL_USER_ID>
```

**Params:**
- `start` (required) — Start date `YYYY-MM-DD`
- `end` (optional) — End date, defaults to today
- `barberGhlId` (optional) — Filter to one barber. Omit to backfill all barbers.

**Notes:**
- For ranges > 45 days, runs async (responds immediately, check server logs)
- Fetches day-by-day per barber to avoid GHL API limits
- 200ms delay between days, 100ms between barbers
- Uses `ignoreDuplicates` upsert — safe to re-run

**Run FIRST** — other backfills depend on the appointments table.

---

## 2. Created-At Backfill (Rebook Attempt Proxy)

**File:** `src/analytics/backfillCreatedAt.js`

**Purpose:** Fetches the real creation timestamp (`dateAdded`) from GHL for appointments that have `ghl_created_at = NULL`. Updates both `ghl_created_at` and `created_at` columns so the rebook attempt proxy ("booked next visit before leaving") has accurate data.

**Endpoint:**
```
POST /api/barbers/analytics/backfill-created-at?barberGhlId=<GHL_USER_ID>
```

**Params:**
- `barberGhlId` (required) — The barber's GHL user ID

**Notes:**
- Fetches each appointment individually via `ghl.calendars.getAppointment()`
- 250ms delay between API calls
- Runs async — check server logs for progress
- Safe to re-run (only touches rows where `ghl_created_at IS NULL`)
- Progress logged every 50 appointments

**Run AFTER appointment backfill** — needs appointment IDs to exist in Supabase.

---

## 3. Analytics Snapshot Backfill

**File:** `src/analytics/snapshotCron.js` → `backfillSnapshots()`

**Purpose:** Computes daily analytics snapshots for historical dates where no snapshot exists. Populates the `barber_analytics_snapshots` table.

**Endpoint:**
```
POST /api/barbers/analytics/backfill-snapshots?start=2025-06-01&end=2026-03-16&barberGhlId=<GHL_USER_ID>
```

**Params:**
- `start` (required) — Start date
- `end` (optional) — End date, defaults to today
- `barberGhlId` (optional) — Filter to one barber

**Notes:**
- Runs async for ranges > 30 days
- Computes all Tier 1 + Tier 2 metrics per day
- Safe to re-run — uses upsert on `(barber_ghl_id, location_id, snapshot_date)`

**Run AFTER appointment backfill** — metrics depend on appointments data.

---

## 4. Monthly Rollup Backfill

**File:** `src/analytics/monthlyRollup.js` → `runMonthlyRollup()`

**Purpose:** Aggregates daily snapshots into monthly trends in the `barber_monthly_trends` table.

**Endpoint:**
```
POST /api/barbers/analytics/monthly-rollup
```

**Notes:**
- Re-aggregates all months from available snapshots
- Safe to re-run — uses upsert

**Run AFTER snapshot backfill.**

---

## Onboarding Sequence

For a new barber, run these in order:

```bash
BARBER_ID="<their GHL user ID>"
BASE="https://studio-az-setter-backend.onrender.com/api/barbers"

# 1. Pull all appointments from GHL (go back to their start date)
curl -X POST "$BASE/analytics/backfill-appointments?start=2025-01-01&barberGhlId=$BARBER_ID"

# 2. Backfill real creation timestamps for rebook attempt proxy
curl -X POST "$BASE/analytics/backfill-created-at?barberGhlId=$BARBER_ID"

# 3. Compute historical analytics snapshots
curl -X POST "$BASE/analytics/backfill-snapshots?start=2025-01-01&barberGhlId=$BARBER_ID"

# 4. Aggregate into monthly trends
curl -X POST "$BASE/analytics/monthly-rollup"
```

All scripts are async for large date ranges — check Render server logs for progress and completion.

---

## Barber GHL User IDs

| Barber | GHL User ID |
|--------|-------------|
| Lionel (Chavez) | `1kFG5FWdUDhXLUX46snG` |

> Add new barbers here as they onboard.
