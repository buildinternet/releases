-- Recommendations submitted from the web app.
-- Today type='source' covers release-note/source URL recommendations.
-- Open POST -> /v1/recommendations; admin read/triage mirrors feedback.
CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'source',
  url TEXT NOT NULL,
  note TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  archived INTEGER NOT NULL DEFAULT 0,
  surface TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT
);
CREATE INDEX idx_recommendations_created ON recommendations (created_at);
CREATE INDEX idx_recommendations_status_created ON recommendations (status, created_at);
CREATE INDEX idx_recommendations_type_created ON recommendations (type, created_at);
CREATE INDEX idx_recommendations_url ON recommendations (url);
