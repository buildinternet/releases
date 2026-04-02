-- Add change_detected_at column for feed change detection
ALTER TABLE sources ADD COLUMN change_detected_at text;
