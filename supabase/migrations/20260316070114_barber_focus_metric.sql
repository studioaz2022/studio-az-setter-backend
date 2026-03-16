CREATE TABLE barber_focus_metric (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  barber_ghl_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  focus_metric TEXT NOT NULL,
  focus_goal NUMERIC(6,2),
  started_at DATE NOT NULL,
  expires_at DATE NOT NULL,
  reason TEXT,
  UNIQUE(barber_ghl_id, location_id)
);
