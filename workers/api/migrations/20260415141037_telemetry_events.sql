CREATE TABLE telemetry_events (
  id TEXT PRIMARY KEY NOT NULL,
  anon_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  surface TEXT NOT NULL,
  client_kind TEXT NOT NULL DEFAULT 'external',
  session_id TEXT,
  agent_name TEXT,
  model TEXT,
  command TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  cli_version TEXT NOT NULL,
  os TEXT,
  arch TEXT,
  runtime TEXT
);

CREATE INDEX idx_telemetry_timestamp ON telemetry_events (timestamp);
CREATE INDEX idx_telemetry_kind_timestamp ON telemetry_events (client_kind, timestamp);
CREATE INDEX idx_telemetry_command_timestamp ON telemetry_events (command, timestamp);
CREATE INDEX idx_telemetry_anon_timestamp ON telemetry_events (anon_id, timestamp);
CREATE INDEX idx_telemetry_session ON telemetry_events (session_id);
