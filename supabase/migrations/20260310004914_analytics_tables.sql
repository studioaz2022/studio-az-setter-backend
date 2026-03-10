-- Analytics tables for barber performance tracking
-- Phase 1: analytics_snapshots, analytics_monthly_trends, coaching_sessions

-- Daily snapshot of each barber's metrics (written by nightly cron)
CREATE TABLE IF NOT EXISTS analytics_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barber_ghl_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    snapshot_date DATE NOT NULL,

    -- Tier 1 metrics
    rebooking_rate_strict DECIMAL,
    rebooking_rate_forgiving DECIMAL,
    first_visit_rebooking_strict DECIMAL,
    first_visit_rebooking_forgiving DECIMAL,
    active_client_count INT,
    active_new_count INT,
    active_returning_count INT,
    regulars_count INT,
    avg_revenue_per_visit DECIMAL,
    avg_tip_percentage DECIMAL,
    no_show_rate DECIMAL,
    cancellation_rate DECIMAL,

    -- Tier 2 metrics (populated in Phase 2)
    attrition_rate_strict DECIMAL,
    attrition_rate_forgiving DECIMAL,
    new_clients_count INT,
    chair_utilization DECIMAL,

    -- Metadata
    computed_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(barber_ghl_id, location_id, snapshot_date)
);

CREATE INDEX idx_snapshots_barber_date ON analytics_snapshots(barber_ghl_id, snapshot_date DESC);
CREATE INDEX idx_snapshots_location_date ON analytics_snapshots(location_id, snapshot_date DESC);

-- Monthly rollup of daily snapshots (for trend charts)
CREATE TABLE IF NOT EXISTS analytics_monthly_trends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barber_ghl_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    month DATE NOT NULL,  -- first day of month (e.g., '2026-03-01')

    -- Rates (monthly average of daily snapshots)
    rebooking_rate_strict DECIMAL,
    rebooking_rate_forgiving DECIMAL,
    first_visit_rebooking_strict DECIMAL,
    first_visit_rebooking_forgiving DECIMAL,
    avg_revenue_per_visit DECIMAL,
    avg_tip_percentage DECIMAL,
    no_show_rate DECIMAL,
    cancellation_rate DECIMAL,
    chair_utilization DECIMAL,

    -- Counts (end-of-month snapshot)
    active_client_count INT,
    regulars_count INT,
    attrition_rate_strict DECIMAL,
    attrition_rate_forgiving DECIMAL,

    -- Totals (sum across the month)
    new_clients_total INT,

    -- Metadata
    computed_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(barber_ghl_id, location_id, month)
);

CREATE INDEX idx_monthly_barber_month ON analytics_monthly_trends(barber_ghl_id, month DESC);

-- AI Coach sessions (stores coaching request/response pairs)
CREATE TABLE IF NOT EXISTS coaching_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barber_ghl_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    requested_at TIMESTAMPTZ DEFAULT NOW(),

    -- What was sent to the LLM
    metrics_snapshot JSONB NOT NULL,
    trend_history JSONB,

    -- What came back
    coaching_response TEXT NOT NULL,
    detected_stage INT,  -- career stage 1-5

    -- Cooldown
    next_available_at TIMESTAMPTZ NOT NULL  -- requested_at + 14 days
);

CREATE INDEX idx_coaching_barber ON coaching_sessions(barber_ghl_id, requested_at DESC);
