ALTER TABLE sources ADD COLUMN fetch_priority TEXT DEFAULT 'normal';
ALTER TABLE sources ADD COLUMN consecutive_no_change INTEGER DEFAULT 0;
ALTER TABLE sources ADD COLUMN consecutive_errors INTEGER DEFAULT 0;
ALTER TABLE sources ADD COLUMN next_fetch_after TEXT;
