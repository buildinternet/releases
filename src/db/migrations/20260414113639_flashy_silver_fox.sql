CREATE TABLE `source_changelog_files` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`path` text NOT NULL,
	`filename` text NOT NULL,
	`url` text NOT NULL,
	`raw_url` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`bytes` integer NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scf_source_path_uq` ON `source_changelog_files` (`source_id`,`path`);--> statement-breakpoint
CREATE INDEX `idx_scf_source` ON `source_changelog_files` (`source_id`);