-- Records one row per scheduled-event execution. Generic over cron_name so
-- future crons can reuse this table. See
-- docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md.
CREATE TABLE `cron_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`cron_name` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_ms` integer,
	`status` text NOT NULL,
	`candidates` integer DEFAULT 0 NOT NULL,
	`dispatched` integer DEFAULT 0 NOT NULL,
	`skipped_over_cap` integer DEFAULT 0 NOT NULL,
	`dispatch_errors` integer DEFAULT 0 NOT NULL,
	`sessions_started` text,
	`dispatch_error_detail` text,
	`abort_reason` text,
	`notes` text
);

CREATE INDEX `idx_cron_runs_name_started` ON `cron_runs` (`cron_name`,`started_at`);
