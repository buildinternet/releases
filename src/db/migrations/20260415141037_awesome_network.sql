CREATE TABLE `telemetry_events` (
	`id` text PRIMARY KEY NOT NULL,
	`anon_id` text NOT NULL,
	`timestamp` integer NOT NULL,
	`surface` text NOT NULL,
	`client_kind` text DEFAULT 'external' NOT NULL,
	`session_id` text,
	`agent_name` text,
	`model` text,
	`command` text NOT NULL,
	`exit_code` integer,
	`duration_ms` integer,
	`cli_version` text NOT NULL,
	`os` text,
	`arch` text,
	`runtime` text
);
--> statement-breakpoint
CREATE INDEX `idx_telemetry_timestamp` ON `telemetry_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_kind_timestamp` ON `telemetry_events` (`client_kind`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_command_timestamp` ON `telemetry_events` (`command`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_anon_timestamp` ON `telemetry_events` (`anon_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_session` ON `telemetry_events` (`session_id`);