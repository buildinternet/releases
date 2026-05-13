-- Add error_category column to fetch_log for machine-readable error classification.
-- Values: infra | extraction | validation | model | NULL (unknown/legacy rows).
ALTER TABLE fetch_log ADD COLUMN error_category TEXT;
