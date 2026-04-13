-- Add type column to releases to distinguish feature releases from seasonal/quarterly rollups
ALTER TABLE releases ADD COLUMN type TEXT NOT NULL DEFAULT 'feature';
