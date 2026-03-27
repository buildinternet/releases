-- Create blocked_urls table for global URL/domain blocking
CREATE TABLE IF NOT EXISTS blocked_urls (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'exact',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Move global ignores (no org_id) to blocked_urls before constraining
INSERT INTO blocked_urls (id, pattern, type, reason, created_at)
  SELECT 'bu_' || substr(id, 4), url, 'exact', reason, ignored_at
  FROM ignored_urls
  WHERE org_id IS NULL;

-- Delete global ignores from ignored_urls
DELETE FROM ignored_urls WHERE org_id IS NULL;

-- Recreate ignored_urls with NOT NULL org_id and composite unique
CREATE TABLE ignored_urls_new (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reason TEXT,
  ignored_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_ignored_urls_org_url ON ignored_urls_new(org_id, url);

INSERT INTO ignored_urls_new (id, url, org_id, reason, ignored_at)
  SELECT id, url, org_id, reason, ignored_at FROM ignored_urls;

DROP TABLE ignored_urls;
ALTER TABLE ignored_urls_new RENAME TO ignored_urls;
