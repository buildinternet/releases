CREATE TABLE `blocked_urls` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`type` text DEFAULT 'exact' NOT NULL,
	`reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocked_urls_pattern_unique` ON `blocked_urls` (`pattern`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ignored_urls` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`org_id` text NOT NULL,
	`reason` text,
	`ignored_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_ignored_urls`("id", "url", "org_id", "reason", "ignored_at") SELECT "id", "url", "org_id", "reason", "ignored_at" FROM `ignored_urls`;--> statement-breakpoint
DROP TABLE `ignored_urls`;--> statement-breakpoint
ALTER TABLE `__new_ignored_urls` RENAME TO `ignored_urls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ignored_urls_org_url` ON `ignored_urls` (`org_id`,`url`);