CREATE TABLE `ignored_urls` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`org_id` text,
	`reason` text,
	`ignored_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ignored_urls_url_unique` ON `ignored_urls` (`url`);