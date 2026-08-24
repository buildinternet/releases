CREATE TABLE idempotency_guards (
  principal_hash TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
  attempt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (principal_hash, key_hash)
);

CREATE INDEX idx_idempotency_guards_expires_at ON idempotency_guards (expires_at);

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

CREATE TRIGGER idempotency_guard_create_response
AFTER INSERT ON idempotency_guards
BEGIN
  INSERT INTO idempotency_records (
    principal_hash,
    key_hash,
    request_hash,
    state,
    attempt_id,
    created_at,
    expires_at
  ) VALUES (
    NEW.principal_hash,
    NEW.key_hash,
    NEW.request_hash,
    NEW.state,
    NEW.attempt_id,
    NEW.created_at,
    NEW.expires_at
  );
END;

CREATE TRIGGER idempotency_guard_delete_response
AFTER DELETE ON idempotency_guards
BEGIN
  DELETE FROM idempotency_records
  WHERE principal_hash = OLD.principal_hash
    AND key_hash = OLD.key_hash;
END;

CREATE TRIGGER idempotency_response_complete_guard
AFTER UPDATE OF state ON idempotency_records
WHEN NEW.state = 'completed'
BEGIN
  UPDATE idempotency_guards
  SET state = 'completed', completed_at = NEW.completed_at
  WHERE principal_hash = NEW.principal_hash
    AND key_hash = NEW.key_hash
    AND attempt_id = NEW.attempt_id
    AND state = 'processing';
  SELECT CASE
    WHEN changes() != 1 THEN RAISE(ABORT, 'idempotency guard completion failed')
  END;
END;
