CREATE TABLE `fetch_log` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`releases_found` integer NOT NULL,
	`releases_inserted` integer NOT NULL,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fetch_log_source` ON `fetch_log` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_fetch_log_created` ON `fetch_log` (`created_at`);