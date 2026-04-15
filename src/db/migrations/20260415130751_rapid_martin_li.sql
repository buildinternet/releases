CREATE TABLE `source_changelog_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_changelog_file_id` text NOT NULL,
	`source_id` text NOT NULL,
	`offset` integer NOT NULL,
	`length` integer NOT NULL,
	`tokens` integer NOT NULL,
	`content_hash` text NOT NULL,
	`heading` text,
	`vector_id` text,
	`embedded_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_changelog_file_id`) REFERENCES `source_changelog_files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scc_file_offset_uq` ON `source_changelog_chunks` (`source_changelog_file_id`,`offset`);--> statement-breakpoint
CREATE INDEX `idx_scc_file` ON `source_changelog_chunks` (`source_changelog_file_id`);--> statement-breakpoint
CREATE INDEX `idx_scc_source` ON `source_changelog_chunks` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_scc_content_hash` ON `source_changelog_chunks` (`content_hash`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `embedded_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `embedded_at` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `embedded_at` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `embedded_at` text;