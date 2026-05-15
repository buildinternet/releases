-- Migration: batch_runs table
-- Tracks Anthropic Message Batch submissions for observability.
-- One row per batch submission; lifecycle: submitted → in_progress → ended | failed.

CREATE TABLE IF NOT EXISTS batch_runs (
  id                       TEXT     PRIMARY KEY NOT NULL,
  anthropic_batch_id       TEXT     NOT NULL UNIQUE,
  caller                   TEXT     NOT NULL,      -- 'script' | 'workflow' | 'admin'
  model                    TEXT     NOT NULL,
  status                   TEXT     NOT NULL,      -- 'submitted' | 'in_progress' | 'ended' | 'failed'
  request_count_total      INTEGER  NOT NULL DEFAULT 0,
  request_count_succeeded  INTEGER  NOT NULL DEFAULT 0,
  request_count_errored    INTEGER  NOT NULL DEFAULT 0,
  request_count_expired    INTEGER  NOT NULL DEFAULT 0,
  request_count_canceled   INTEGER  NOT NULL DEFAULT 0,
  created_at               TEXT     NOT NULL,
  ended_at                 TEXT,
  est_cost_usd             REAL,
  actual_cost_usd          REAL,
  caller_context           TEXT,   -- JSON
  error_summary            TEXT    -- JSON
);

CREATE INDEX IF NOT EXISTS idx_batch_runs_created_at    ON batch_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_batch_runs_anthropic_id  ON batch_runs (anthropic_batch_id);
