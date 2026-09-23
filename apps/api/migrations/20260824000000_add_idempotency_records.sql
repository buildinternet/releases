CREATE TABLE idempotency_records (
  principal_hash TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
  attempt_id TEXT NOT NULL,
  response_status INTEGER,
  response_headers TEXT,
  response_body TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (principal_hash, key_hash)
);

CREATE INDEX idx_idempotency_records_expires_at ON idempotency_records (expires_at);
