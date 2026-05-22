-- Feedback submitted via `releases feedback`. Open POST → /v1/feedback.
-- Distinct from telemetry_events: carries intentional free text + optional contact.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  contact TEXT,
  type TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'new',
  cli_version TEXT,
  client_kind TEXT NOT NULL DEFAULT 'external',
  anon_id TEXT,
  os TEXT,
  arch TEXT,
  runtime TEXT,
  surface TEXT NOT NULL DEFAULT 'cli'
);
CREATE INDEX idx_feedback_created ON feedback (created_at);
CREATE INDEX idx_feedback_status_created ON feedback (status, created_at);
CREATE INDEX idx_feedback_anon ON feedback (anon_id);
