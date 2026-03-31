-- Add media column to releases table for structured media references
ALTER TABLE releases ADD COLUMN media TEXT DEFAULT '[]';
