CREATE TABLE money_leak_scorecard (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  barber_ghl_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  total_money_leaked NUMERIC(10,2),
  biggest_leak_name TEXT,
  biggest_leak_amount NUMERIC(10,2),
  focus_metric TEXT,
  focus_current NUMERIC(10,2),
  focus_goal NUMERIC(10,2),
  weekly_income_goal NUMERIC(10,2),
  weekly_income_pace NUMERIC(10,2),
  goal_delta NUMERIC(10,2),
  best_week_revenue NUMERIC(10,2),
  best_week_date DATE,
  rebook_attempt_rate NUMERIC(6,2),
  scorecard_data JSONB,
  computed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(barber_ghl_id, location_id, week_start)
);

CREATE INDEX idx_scorecard_barber_week ON money_leak_scorecard(barber_ghl_id, week_start DESC);
