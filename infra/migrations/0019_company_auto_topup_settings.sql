-- Auto top-up configuration on company commercial settings (additive).
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_threshold_cents INTEGER;
ALTER TABLE company_commercial_settings ADD COLUMN auto_top_up_amount_cents INTEGER;
