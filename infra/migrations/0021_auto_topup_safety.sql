-- Auto top-up safety: daily cap, failure suppression
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_daily_cap_cents INTEGER;
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_daily_spent_cents INTEGER DEFAULT 0;
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_day_key TEXT;
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_failed_count INTEGER DEFAULT 0;
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_suppressed_until TEXT;
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_last_failure_at TEXT;
