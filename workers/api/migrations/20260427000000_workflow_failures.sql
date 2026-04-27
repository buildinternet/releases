-- Records per-source workflow failures from the poll-and-fetch fan-out.
-- One row per failed workflow instance; keyed by (source_id, scheduled_time)
-- so the summary workflow can aggregate all failures for a given cron fire.
-- See workers/api/src/workflows/poll-and-fetch.ts and the send-alert docs.
CREATE TABLE IF NOT EXISTS `workflow_failures` (
  `id` text PRIMARY KEY NOT NULL,
  `scheduled_time` integer NOT NULL,
  `source_id` text NOT NULL,
  `step_name` text NOT NULL,
  `error` text NOT NULL,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS `idx_workflow_failures_scheduled` ON `workflow_failures` (`scheduled_time`);
