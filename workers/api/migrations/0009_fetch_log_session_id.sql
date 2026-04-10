-- Add session_id column to fetch_log for correlating fetches to agent sessions
ALTER TABLE fetch_log ADD COLUMN session_id TEXT;
CREATE INDEX idx_fetch_log_session ON fetch_log (session_id);
