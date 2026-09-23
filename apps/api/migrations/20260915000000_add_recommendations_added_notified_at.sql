-- Opt-in "your source was added" stamp on recommendations.
-- NULL = never sent. Only the explicit notify-added admin path writes this;
-- triage / close / archive do not.
ALTER TABLE recommendations ADD COLUMN added_notified_at INTEGER;
