-- Add suppression columns to releases table
ALTER TABLE releases ADD COLUMN suppressed INTEGER DEFAULT 0;
ALTER TABLE releases ADD COLUMN suppressed_reason TEXT;
